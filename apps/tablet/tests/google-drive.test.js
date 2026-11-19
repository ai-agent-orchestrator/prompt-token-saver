import test from 'node:test';
import assert from 'node:assert/strict';
import { GoogleDriveConnector, GoogleDriveError, extractGoogleDocument } from '../src/drive/google-drive.js';

const DOC = 'application/vnd.google-apps.document';
const FOLDER = 'application/vnd.google-apps.folder';
const SCOPE = 'https://www.googleapis.com/auth/drive.file';
const TOKEN = 'fake-token-never-persist';
const paragraph = (text, startIndex = 1) => ({
  paragraph: { elements: [{ startIndex, endIndex: startIndex + text.length, textRun: { content: text } }] },
});
const doc = (id, text = '\n', revisionId = 'r1') => ({
  documentId: id, title: id, revisionId,
  tabs: [{ tabProperties: { tabId: 'tab1' }, documentTab: { body: { content: [paragraph(text)] } } }],
});
const reply = (body, status = 200) => ({ ok: status >= 200 && status < 300, status, json: async () => structuredClone(body) });

function server() {
  const files = new Map();
  const documents = new Map();
  const calls = [];
  let nextId = 0;
  let hook = () => {};
  const fetchImpl = async (url, options = {}) => {
    const parsed = new URL(url);
    const method = options.method || 'GET';
    const body = options.body ? JSON.parse(options.body) : null;
    const request = { url: parsed, method, body, headers: options.headers, signal: options.signal };
    calls.push(request);
    const early = await hook(request, 'before');
    if (early) return early;
    let response;
    if (parsed.hostname === 'www.googleapis.com') {
      const id = parsed.pathname.match(/\/files\/([^/]+)$/)?.[1];
      if (method === 'GET' && !id) {
        const operationId = parsed.searchParams.get('q')?.match(/value='([^']+)'/)?.[1];
        response = reply({ files: [...files.values()].filter(file => file.appProperties?.operationId === operationId) });
      } else if (method === 'GET' && id) {
        response = files.has(id) ? reply(files.get(id)) : reply({}, 404);
      } else if (method === 'POST' && !id) {
        const created = { ...body, id: `file_${++nextId}`, version: '1', modifiedTime: '2026-11-18T00:00:00Z' };
        files.set(created.id, created);
        if (body.mimeType === DOC) documents.set(created.id, doc(created.id));
        response = reply(created);
      } else throw new Error('Unexpected Drive request');
    } else if (parsed.hostname === 'docs.googleapis.com') {
      const id = parsed.pathname.replace('/v1/documents/', '').replace(':batchUpdate', '');
      if (method === 'GET') response = documents.has(id) ? reply(documents.get(id)) : reply({}, 404);
      else if (method === 'POST' && parsed.pathname.endsWith(':batchUpdate')) {
        const current = documents.get(id);
        if (body.writeControl.requiredRevisionId !== current.revisionId) return reply({}, 400);
        const insertion = body.requests[0].insertText;
        assert.equal(insertion.location.tabId, 'tab1');
        assert.equal(insertion.location.index, 1);
        const oldText = current.tabs[0].documentTab.body.content[0].paragraph.elements[0].textRun.content;
        documents.set(id, doc(id, insertion.text + oldText, `${current.revisionId}x`));
        response = reply({ documentId: id, writeControl: { requiredRevisionId: `${current.revisionId}x` } });
      } else throw new Error('Unexpected Docs request');
    } else throw new Error('Token sent to unexpected origin');
    const late = await hook(request, 'after');
    return late || response;
  };
  return { files, documents, calls, fetchImpl, setHook(value) { hook = value; } };
}

async function connected(api, tokenResponse = {}) {
  const previous = globalThis.google;
  globalThis.google = { accounts: { oauth2: {
    initTokenClient(options) {
      assert.equal(options.scope, SCOPE);
      assert.equal(options.include_granted_scopes, false);
      return { requestAccessToken() { options.callback({ access_token: TOKEN, expires_in: 3600, scope: SCOPE, ...tokenResponse }); } };
    },
  } } };
  try {
    const connector = new GoogleDriveConnector({ clientId: 'client', apiKey: 'key', appId: '1234', fetchImpl: api.fetchImpl });
    await connector.connect();
    return connector;
  } finally { globalThis.google = previous; }
}

const bundle = (extra = {}) => ({
  runId: 'run_123', title: '연구 묶음',
  artifacts: [{ key: 'summary', title: '통합 요약', text: '가😀나\n두 번째 문단' }],
  ...extra,
});

test('extracts nested tabs, nested tables, notes and source Unicode coordinates', () => {
  const input = {
    title: '다중 탭', tabs: [{
      tabProperties: { tabId: 'parent' },
      documentTab: {
        body: { content: [paragraph('가😀나\n'), { table: { tableRows: [{ tableCells: [{ content: [
          paragraph('표 안'), { table: { tableRows: [{ tableCells: [{ content: [paragraph('중첩 표')] }] }] } },
        ] }] }] } }] },
        footnotes: { note1: { content: [paragraph('각주 근거')] } },
      },
      childTabs: [{ tabProperties: { tabId: 'child' }, documentTab: { body: { content: [paragraph('마지막 핵심 조건')] } } }],
    }],
  };
  const result = extractGoogleDocument(input);
  assert.equal(result.tabCount, 2);
  for (const text of ['가😀나', '표 안', '중첩 표', '각주 근거', '마지막 핵심 조건']) assert.ok(result.text.includes(text));
  const first = result.spans[0];
  assert.deepEqual(first.utf16Offsets, [0, 1, 3, 4, 5]);
  assert.equal(first.start, 0);
  assert.equal(first.end, 4);
  assert.equal(first.docsStartIndex + first.utf16Offsets[2], 4);
  assert.equal(first.tabId, 'parent');
  assert.equal(result.unsupportedCount, 0);
});

test('preserves hyperlink targets and labels unsupported source elements', () => {
  const input = doc('source', '출처');
  const elements = input.tabs[0].documentTab.body.content[0].paragraph.elements;
  elements[0].textRun.textStyle = { link: { url: 'https://example.org/paper' } };
  elements.push({ inlineObjectElement: { inlineObjectId: 'image' } });
  const result = extractGoogleDocument(input);
  assert.ok(result.text.includes('https://example.org/paper'));
  assert.equal(result.unsupportedCount, 1);
  assert.deepEqual(result.warnings, ['UNSUPPORTED_ELEMENTS']);
});

test('read-only source has nullable revision, includes all content, and sends GET only', async () => {
  const api = server();
  api.files.set('source', { id: 'source', name: '원문', mimeType: DOC, version: '5', modifiedTime: 'now' });
  const input = doc('source', '원문😀');
  delete input.revisionId;
  input.tabs[0].childTabs = [{ tabProperties: { tabId: 'child' }, documentTab: { body: { content: [paragraph('뒤쪽')] } } }];
  api.documents.set('source', input);
  const connector = await connected(api);
  const result = await connector.readDocument({ id: 'source' });
  assert.equal(result.source.revision, null);
  assert.equal(result.source.tabCount, 2);
  assert.ok(result.text.includes('뒤쪽'));
  assert.equal(result.source.modifiedDuringRead, false);
  assert.ok(api.calls.every(call => call.method === 'GET'));
  assert.equal(api.calls[1].url.searchParams.get('includeTabsContent'), 'true');
});

test('marks a source modified between the metadata reads', async () => {
  const api = server();
  api.files.set('source', { id: 'source', name: '원문', mimeType: DOC, version: '1' });
  api.documents.set('source', doc('source', '가져온 본문'));
  api.setHook((request, phase) => {
    if (phase === 'after' && request.url.hostname === 'docs.googleapis.com') api.files.get('source').version = '2';
  });
  const connector = await connected(api);
  const result = await connector.readDocument({ id: 'source' });
  assert.equal(result.source.modifiedDuringRead, true);
  assert.equal(result.source.versionBefore, '1');
  assert.equal(result.source.versionAfter, '2');
  assert.ok(result.warnings.includes('SOURCE_CHANGED_DURING_READ'));
});

test('source version recheck detects edits after analysis without writing or changing the snapshot', async () => {
  const api = server();
  api.files.set('source', { id: 'source', name: '원문', mimeType: DOC,
    version: '9007199254740993', modifiedTime: '2026-11-18T00:00:00Z' });
  api.documents.set('source', doc('source', '분석에 사용한 본문'));
  const connector = await connected(api);
  const snapshot = await connector.readDocument({ id: 'source' });
  const stored = structuredClone(snapshot.source);
  api.files.get('source').version = '9007199254740994';
  api.files.get('source').modifiedTime = '2026-11-18T00:10:00Z';
  const result = await connector.checkSourceVersion(snapshot.source);
  assert.deepEqual(result, { changed: true, version: '9007199254740994', modifiedTime: '2026-11-18T00:10:00Z' });
  assert.deepEqual(snapshot.source, stored);
  assert.ok(api.calls.every(call => call.method === 'GET'));
  assert.throws(() => connector._assertWritable('source'), { code: 'SOURCE_WRITE_BLOCKED' });
});

test('source version recheck accepts unchanged snapshots and independently checks modifiedTime', async () => {
  const api = server();
  api.files.set('source', { id: 'source', name: '원문', mimeType: DOC, version: '5', modifiedTime: 'original-time' });
  const connector = await connected(api);
  const source = { fileId: 'source', version: '5', modifiedTime: 'original-time' };
  assert.deepEqual(await connector.checkSourceVersion(source), { changed: false, version: '5', modifiedTime: 'original-time' });
  api.files.get('source').modifiedTime = 'new-time';
  assert.deepEqual(await connector.checkSourceVersion(source), { changed: true, version: '5', modifiedTime: 'new-time' });
  assert.equal(api.calls.length, 2);
  assert.ok(api.calls.every(call => call.method === 'GET'));
});

test('source version recheck skips local inputs and protects a source even before it was read', async () => {
  const api = server();
  const connector = new GoogleDriveConnector({ fetchImpl: api.fetchImpl });
  for (const source of [undefined, null, {}, { fileId: null }]) {
    assert.deepEqual(await connector.checkSourceVersion(source), { changed: false, version: null, modifiedTime: null });
  }
  assert.equal(api.calls.length, 0);
  await assert.rejects(connector.checkSourceVersion({ fileId: 'source', version: '1' }), { code: 'AUTH_REQUIRED' });
  assert.throws(() => connector._assertWritable('source'), { code: 'SOURCE_WRITE_BLOCKED' });
  await assert.rejects(connector.checkSourceVersion({ fileId: '../invalid' }), { code: 'VALIDATION_ERROR' });
});

test('source version auth failures are sanitized and invalidate the expired grant', async () => {
  const api = server();
  api.setHook((request, phase) => phase === 'before' ? reply({ error: `untrusted ${TOKEN}` }, 401) : undefined);
  const connector = await connected(api);
  await assert.rejects(connector.checkSourceVersion({ fileId: 'source', version: '1', modifiedTime: 'time' }), error => {
    assert.ok(error instanceof GoogleDriveError);
    assert.equal(error.code, 'AUTH_REQUIRED');
    assert.ok(!error.message.includes(TOKEN));
    assert.ok(!JSON.stringify(error).includes(TOKEN));
    return true;
  });
  assert.equal(connector.isConnected, false);
  assert.equal(api.calls.length, 1);
  assert.equal(api.calls[0].method, 'GET');
});

test('saves new app-owned output, persists a token-free ledger, and reuses verified IDs', async () => {
  const api = server();
  const connector = await connected(api);
  const checkpoints = [];
  const result = await connector.saveBundle(bundle({ onLedger: async value => checkpoints.push(value) }));
  assert.equal(result.status, 'SAVED');
  assert.equal(result.artifacts[0].status, 'SAVED');
  assert.equal(api.files.size, 2);
  const created = api.files.get(result.artifacts[0].id);
  assert.deepEqual(created.parents, [result.folderId]);
  assert.equal(created.appProperties.runId, 'run_123');
  assert.ok(checkpoints.some(value => value.operations.summary.state === 'CREATING'));
  assert.ok(!JSON.stringify(checkpoints).includes(TOKEN));
  assert.ok(!JSON.stringify(result).includes(TOKEN));
  const repeated = await connector.saveBundle(bundle({ ledger: result.ledger }));
  assert.equal(repeated.status, 'SAVED');
  assert.equal(repeated.artifacts[0].id, result.artifacts[0].id);
  assert.equal(api.files.size, 2);
  assert.equal(api.calls.filter(call => call.url.pathname.endsWith(':batchUpdate')).length, 1);
});

test('unknown create with no visible result is not blindly resent on resume', async () => {
  const api = server();
  api.setHook((request, phase) => {
    if (phase === 'before' && request.method === 'POST' && request.body?.mimeType === DOC) throw new Error(`network failure ${TOKEN}`);
  });
  const connector = await connected(api);
  const first = await connector.saveBundle(bundle());
  assert.equal(first.status, 'SAVE_UNKNOWN');
  assert.equal(first.ledger.operations.summary.state, 'UNKNOWN');
  const next = await connector.saveBundle(bundle({ ledger: first.ledger }));
  assert.equal(next.status, 'SAVE_UNKNOWN');
  assert.equal(api.calls.filter(call => call.method === 'POST' && call.body?.mimeType === DOC).length, 1);
  assert.ok(!JSON.stringify(next).includes(TOKEN));
});

test('a created file with a lost response is recovered through operation properties', async () => {
  const api = server();
  let lost = false;
  api.setHook((request, phase) => {
    if (!lost && phase === 'after' && request.method === 'POST' && request.body?.mimeType === DOC) {
      lost = true;
      throw new Error('response lost');
    }
  });
  const connector = await connected(api);
  const result = await connector.saveBundle(bundle());
  assert.equal(result.status, 'SAVED');
  assert.equal(api.files.size, 2);
  assert.equal(api.calls.filter(call => call.method === 'POST' && call.body?.mimeType === DOC).length, 1);
});

test('lost insert response is read back without duplicating document text', async () => {
  const api = server();
  let lost = false;
  api.setHook((request, phase) => {
    if (!lost && phase === 'after' && request.url.pathname.endsWith(':batchUpdate')) {
      lost = true;
      throw new Error(`untrusted server exception ${TOKEN}`);
    }
  });
  const connector = await connected(api);
  const result = await connector.saveBundle(bundle());
  assert.equal(result.status, 'SAVED');
  const next = await connector.saveBundle(bundle({ ledger: result.ledger }));
  assert.equal(next.status, 'SAVED');
  assert.equal(api.calls.filter(call => call.url.pathname.endsWith(':batchUpdate')).length, 1);
  assert.equal(api.documents.get(result.artifacts[0].id).tabs[0].documentTab.body.content[0].paragraph.elements[0].textRun.content, `${bundle().artifacts[0].text}\n`);
});

test('lost write whose readback also fails stays UNKNOWN and is resolved on resume', async () => {
  const api = server();
  let inserted = false;
  let blockReadback = true;
  api.setHook((request, phase) => {
    if (phase === 'after' && request.url.pathname.endsWith(':batchUpdate')) { inserted = true; throw new Error('lost'); }
    if (phase === 'before' && inserted && blockReadback && request.url.hostname === 'docs.googleapis.com' && request.method === 'GET') throw new Error('offline');
  });
  const connector = await connected(api);
  const first = await connector.saveBundle(bundle());
  assert.equal(first.status, 'SAVE_UNKNOWN');
  blockReadback = false;
  const next = await connector.saveBundle(bundle({ ledger: first.ledger }));
  assert.equal(next.status, 'SAVED');
  assert.equal(api.calls.filter(call => call.url.pathname.endsWith(':batchUpdate')).length, 1);
});

test('partial bundle can resume only failed artifacts', async () => {
  const api = server();
  let failSecond = true;
  api.setHook((request, phase) => {
    if (phase === 'before' && failSecond && request.method === 'POST' && request.body?.name === '둘째') return reply({ error: TOKEN }, 403);
  });
  const connector = await connected(api);
  const options = bundle({ artifacts: [{ key: 'first', title: '첫째', text: 'A' }, { key: 'second', title: '둘째', text: 'B' }] });
  const first = await connector.saveBundle(options);
  assert.equal(first.status, 'SAVE_PARTIAL');
  assert.deepEqual(first.artifacts.map(item => item.status), ['SAVED', 'FAILED']);
  failSecond = false;
  const next = await connector.saveBundle({ ...options, ledger: first.ledger });
  assert.equal(next.status, 'SAVED');
  assert.equal(next.artifacts[0].id, first.artifacts[0].id);
  assert.equal(api.files.size, 3);
  assert.equal(api.calls.filter(call => call.url.pathname.endsWith(':batchUpdate')).length, 2);
});

test('remote edits are never overwritten', async () => {
  const api = server();
  const connector = await connected(api);
  const first = await connector.saveBundle(bundle());
  const id = first.artifacts[0].id;
  api.documents.set(id, doc(id, '사용자가 고친 내용\n', 'human-r2'));
  const next = await connector.saveBundle(bundle({ ledger: first.ledger }));
  assert.equal(next.status, 'SAVE_PARTIAL');
  assert.equal(next.artifacts[0].errorCode, 'REMOTE_CONFLICT');
  assert.equal(api.calls.filter(call => call.url.pathname.endsWith(':batchUpdate')).length, 1);
});

test('source IDs cannot be used as output IDs, including poisoned ledgers', async () => {
  const api = server();
  const connector = await connected(api);
  const first = await connector.saveBundle(bundle());
  const id = first.artifacts[0].id;
  const beforeWrites = api.calls.filter(call => call.method === 'POST').length;
  const next = await connector.saveBundle(bundle({ sourceFileId: id, ledger: first.ledger }));
  assert.equal(next.status, 'SAVE_PARTIAL');
  assert.equal(next.artifacts[0].errorCode, 'SOURCE_WRITE_BLOCKED');
  assert.equal(api.calls.filter(call => call.method === 'POST').length, beforeWrites);
});

test('tokens and raw server error text never enter an auth error or result', async () => {
  const api = server();
  api.setHook((request, phase) => phase === 'before' ? reply({ error: `bad token ${TOKEN}` }, 401) : undefined);
  const connector = await connected(api);
  await assert.rejects(connector.readDocument({ id: 'source' }), error => {
    assert.ok(error instanceof GoogleDriveError);
    assert.equal(error.code, 'AUTH_REQUIRED');
    assert.ok(!error.message.includes(TOKEN));
    return true;
  });
  assert.equal(connector.isConnected, false);
  const result = await connector.saveBundle(bundle());
  assert.equal(result.status, 'SAVE_PARTIAL');
  assert.equal(result.ledger.operations._folder.errorCode, 'AUTH_REQUIRED');
  assert.ok(!JSON.stringify(result).includes(TOKEN));
});

test('rejects duplicate keys, oversized content and content changes in the same run', async () => {
  const api = server();
  const connector = await connected(api);
  await assert.rejects(connector.saveBundle(bundle({ artifacts: [{ key: 'same', title: 'A', text: 'A' }, { key: 'same', title: 'B', text: 'B' }] })), { code: 'VALIDATION_ERROR' });
  await assert.rejects(connector.saveBundle(bundle({ artifacts: [{ key: 'large', title: 'A', text: 'x'.repeat(250_001) }] })), { code: 'VALIDATION_ERROR' });
  assert.equal(api.calls.length, 0);
  const first = await connector.saveBundle(bundle());
  await assert.rejects(connector.saveBundle(bundle({ ledger: first.ledger, artifacts: [{ key: 'summary', title: '통합 요약', text: '다른 내용' }] })), { code: 'RUN_CONTENT_CHANGED' });
});

test('a ledger persistence failure blocks an undispatched create', async () => {
  const api = server();
  const connector = await connected(api);
  const result = await connector.saveBundle(bundle({ onLedger: async () => { throw new Error(TOKEN); } }));
  assert.equal(result.status, 'SAVE_PARTIAL');
  assert.equal(api.calls.filter(call => call.method === 'POST').length, 0);
  assert.equal(result.ledger.operations._folder.errorCode, 'LEDGER_WRITE_FAILED');
});

test('serializes calls sharing one connector and reconciles the second call', async () => {
  const api = server();
  const connector = await connected(api);
  const [first, second] = await Promise.all([connector.saveBundle(bundle()), connector.saveBundle(bundle())]);
  assert.equal(first.status, 'SAVED');
  assert.equal(second.status, 'SAVED');
  assert.equal(first.artifacts[0].id, second.artifacts[0].id);
  assert.equal(api.files.size, 2);
});

test('a known expired grant is rejected without a request', async () => {
  const api = server();
  await assert.rejects(connected(api, { expires_in: 0 }), { code: 'AUTH_REQUIRED' });
  assert.equal(api.calls.length, 0);
});

test('Picker uses the granted file scope and protects the selected source ID', async () => {
  const api = server();
  const connector = await connected(api);
  const previous = globalThis.google;
  const observed = {};
  class DocsView {
    constructor(view) { observed.view = view; }
    setMimeTypes(value) { observed.mime = value; return this; }
  }
  class PickerBuilder {
    addView() { return this; }
    setOAuthToken(value) { observed.token = value; return this; }
    setDeveloperKey(value) { observed.key = value; return this; }
    setAppId(value) { observed.appId = value; return this; }
    setCallback(callback) { this.callback = callback; return this; }
    build() { return { setVisible: () => this.callback({ action: 'picked', docs: [{ id: 'picked_source', name: '원문', mimeType: DOC }] }) }; }
  }
  globalThis.google = { picker: { DocsView, PickerBuilder, ViewId: { DOCS: 'docs' }, Action: { PICKED: 'picked', CANCEL: 'cancel' } } };
  try {
    const selected = await connector.pickDocument();
    assert.deepEqual(selected, { id: 'picked_source', name: '원문', mimeType: DOC });
    assert.equal(observed.mime, DOC);
    assert.equal(observed.appId, '1234');
    assert.equal(observed.token, TOKEN);
    assert.throws(() => connector._assertWritable(selected.id), { code: 'SOURCE_WRITE_BLOCKED' });
  } finally { globalThis.google = previous; }
});

test('an ambiguous aborted create is reconciled later without resending it', async () => {
  const api = server();
  const controller = new AbortController();
  let aborted = false;
  api.setHook((request, phase) => {
    if (!aborted && phase === 'after' && request.method === 'POST' && request.body?.mimeType === DOC) {
      aborted = true;
      controller.abort();
      throw new Error('transport aborted after the server committed');
    }
  });
  const connector = await connected(api);
  const first = await connector.saveBundle(bundle({ signal: controller.signal }));
  assert.equal(first.status, 'SAVE_UNKNOWN');
  const next = await connector.saveBundle(bundle({ ledger: first.ledger }));
  assert.equal(next.status, 'SAVED');
  assert.equal(api.calls.filter(call => call.method === 'POST' && call.body?.mimeType === DOC).length, 1);
});

test('disconnect prevents a late OAuth callback from restoring the grant', async () => {
  const previous = globalThis.google;
  let callback;
  globalThis.google = { accounts: { oauth2: {
    initTokenClient(options) { callback = options.callback; return { requestAccessToken() {} }; },
  } } };
  try {
    const connector = new GoogleDriveConnector({ clientId: 'client', apiKey: 'key', appId: '1234' });
    const pending = connector.connect();
    connector.disconnect();
    callback({ access_token: TOKEN, scope: SCOPE, expires_in: 3600 });
    await assert.rejects(pending, { code: 'AUTH_CANCELLED' });
    assert.equal(connector.isConnected, false);
  } finally { globalThis.google = previous; }
});

test('saved list reads only app-created folders with bounded pagination', async () => {
  const api = server();
  const folder = id => ({ id, name: `저장된 ${id}`, webViewLink: 'https://example.invalid/untrusted',
    modifiedTime: '2026-11-18T03:00:00Z', appProperties: { artifactRole: 'bundle-folder', runId: `run_${id}` } });
  api.setHook((request, phase) => {
    if (phase !== 'before') return;
    assert.equal(request.method, 'GET');
    assert.equal(request.url.searchParams.get('orderBy'), 'modifiedTime desc');
    assert.match(request.url.searchParams.get('q'), /trashed = false/);
    assert.match(request.url.searchParams.get('q'), /artifactRole.*bundle-folder/);
    assert.match(request.url.searchParams.get('q'), /application\/vnd.google-apps.folder/);
    assert.equal(request.headers.Authorization, `Bearer ${TOKEN}`);
    if (!request.url.searchParams.has('pageToken')) {
      assert.equal(request.url.searchParams.get('pageSize'), '100');
      return reply({ files: [folder('first'), { id: 'not_ours', name: '다른 앱', appProperties: {} }], nextPageToken: 'next/page+2' });
    }
    assert.equal(request.url.searchParams.get('pageToken'), 'next/page+2');
    return reply({ files: [folder('second')] });
  });
  const connector = await connected(api);
  const first = await connector.listSaved({ pageSize: 1000 });
  assert.equal(first.items.length, 1);
  assert.deepEqual(first.items[0], { id: 'first', title: '저장된 first',
    url: 'https://drive.google.com/drive/folders/first', modifiedAt: '2026-11-18T03:00:00Z', runId: 'run_first' });
  const next = await connector.listSaved({ pageToken: first.nextPageToken });
  assert.equal(next.items[0].id, 'second');
  assert.equal(next.nextPageToken, null);
  assert.equal(api.calls.length, 2);
  assert.ok(!JSON.stringify([first, next]).includes(TOKEN));
});

test('saved list handles auth expiry without disclosing server errors or tokens', async () => {
  const api = server();
  api.setHook(() => reply({ error: TOKEN }, 401));
  const connector = await connected(api);
  await assert.rejects(connector.listSaved(), error => {
    assert.equal(error.code, 'AUTH_REQUIRED');
    assert.ok(!JSON.stringify(error).includes(TOKEN));
    assert.ok(!error.message.includes(TOKEN));
    return true;
  });
  assert.equal(connector.isConnected, false);
  assert.equal(api.calls.length, 1);
  await assert.rejects(connector.listSaved(), { code: 'AUTH_REQUIRED' });
  assert.equal(api.calls.length, 1);
});

test('saved list validates page options before sending a request', async () => {
  const api = server();
  const connector = await connected(api);
  for (const options of [{ pageSize: 0 }, { pageSize: 1.5 }, { pageToken: 'x'.repeat(4097) }, { pageToken: '\n' }]) {
    await assert.rejects(connector.listSaved(options), { code: 'VALIDATION_ERROR' });
  }
  assert.equal(api.calls.length, 0);
});

test('saved list supports a fresh account without any saved folders', async () => {
  const api = server();
  api.setHook(() => reply({}));
  const connector = await connected(api);
  assert.deepEqual(await connector.listSaved(), { items: [], nextPageToken: null });
});
