const DRIVE_FILE = 'https://www.googleapis.com/auth/drive.file';
const DRIVE_API = 'https://www.googleapis.com/drive/v3/files';
const DOCS_API = 'https://docs.googleapis.com/v1/documents';
const DOC_MIME = 'application/vnd.google-apps.document';
const FOLDER_MIME = 'application/vnd.google-apps.folder';
const MAX_ARTIFACTS = 32;
const MAX_SOURCE_CODEPOINTS = 1_000_000;
const scripts = new Map();

const messages = {
  AUTH_REQUIRED: 'Google 연결이 필요합니다. 로컬 결과를 유지하고 다시 연결해 주세요.',
  AUTH_CANCELLED: 'Google 연결이 취소되었거나 창을 열 수 없습니다.',
  SETUP_REQUIRED: 'Google 연결 설정을 확인해 주세요.',
  SDK_LOAD_FAILED: 'Google 연결 도구를 불러오지 못했습니다.',
  VALIDATION_ERROR: '입력 또는 산출물의 형식과 크기를 확인해 주세요.',
  INVALID_LEDGER: '저장 장부가 이 실행과 일치하지 않습니다.',
  RUN_CONTENT_CHANGED: '같은 실행의 산출물이 변경되었습니다. 새 실행으로 저장해 주세요.',
  REQUEST_FAILED: 'Google 요청의 결과를 확인하지 못했습니다.',
  REQUEST_ABORTED: 'Google 요청이 중단되었습니다.',
  HTTP_ERROR: 'Google 요청을 완료하지 못했습니다.',
  UNSUPPORTED_DOCUMENT: '현재 Google 문서 형식만 지원합니다.',
  SOURCE_TOO_LARGE: '문서가 현재 처리 상한을 초과했습니다.',
  SOURCE_WRITE_BLOCKED: '입력 원본은 수정할 수 없습니다.',
  REMOTE_CONFLICT: '원격 문서가 변경되었습니다. 새 판 저장이 필요합니다.',
  OWNERSHIP_MISMATCH: '앱이 생성한 산출물임을 확인하지 못했습니다.',
  SAVE_UNKNOWN: '저장 결과가 불명확합니다. 확인 전에는 새 파일을 만들지 않습니다.',
  LEDGER_WRITE_FAILED: '저장 장부를 기록하지 못했습니다.',
};

export class GoogleDriveError extends Error {
  constructor(code, { status = null, ambiguous = false } = {}) {
    super(messages[code] || messages.REQUEST_FAILED);
    this.name = 'GoogleDriveError';
    this.code = Object.hasOwn(messages, code) ? code : 'REQUEST_FAILED';
    this.status = status;
    this.ambiguous = ambiguous;
  }
}

function failure(code, details) { return new GoogleDriveError(code, details); }
function safeCode(error) { return error instanceof GoogleDriveError ? error.code : 'REQUEST_FAILED'; }
function validId(value) { return typeof value === 'string' && /^[A-Za-z0-9_-]{1,200}$/.test(value); }
function copy(value) { return JSON.parse(JSON.stringify(value)); }
function codepoints(value) { return Array.from(value).length; }
function docUrl(id) { return `https://docs.google.com/document/d/${id}/edit`; }
function folderUrl(id) { return `https://drive.google.com/drive/folders/${id}`; }

async function sha256(value) {
  const bytes = new TextEncoder().encode(value);
  const digest = await globalThis.crypto.subtle.digest('SHA-256', bytes);
  return Array.from(new Uint8Array(digest), byte => byte.toString(16).padStart(2, '0')).join('');
}

function loadScript(url) {
  if (scripts.has(url)) return scripts.get(url);
  const promise = new Promise((resolve, reject) => {
    if (!globalThis.document?.createElement) { reject(failure('SDK_LOAD_FAILED')); return; }
    const script = document.createElement('script');
    script.src = url;
    script.async = true;
    script.onload = resolve;
    script.onerror = () => { scripts.delete(url); script.remove(); reject(failure('SDK_LOAD_FAILED')); };
    document.head.append(script);
  });
  scripts.set(url, promise);
  return promise;
}

/** Extract all tabs, nested tables and notes without changing the Drive source.
 * Each text span maps snapshot codepoints to the API's UTF-16 coordinates.
 * Synthetic separators and link annotations have kind other than `text`.
 */
export function extractGoogleDocument(doc) {
  if (!doc || typeof doc !== 'object') throw failure('UNSUPPORTED_DOCUMENT');
  const pieces = [];
  const spans = [];
  const warnings = new Set();
  let length = 0;
  let tabCount = 0;
  let unsupportedCount = 0;
  let visited = 0;

  function append(text, context = {}, element = {}, kind = 'text') {
    if (typeof text !== 'string' || !text) return;
    const offsets = [0];
    let utf16 = 0;
    for (const point of text) { utf16 += point.length; offsets.push(utf16); }
    const count = offsets.length - 1;
    if (length + count > MAX_SOURCE_CODEPOINTS) throw failure('SOURCE_TOO_LARGE');
    spans.push({
      start: length, end: length + count, kind,
      tabId: context.tabId ?? null, segmentId: context.segmentId ?? null,
      docsStartIndex: Number.isInteger(element.startIndex) ? element.startIndex : null,
      docsEndIndex: Number.isInteger(element.endIndex) ? element.endIndex : null,
      // At snapshot offset start+i, use docsStartIndex+utf16Offsets[i].
      utf16Offsets: kind === 'text' ? offsets : null,
    });
    length += count;
    pieces.push(text);
  }

  function unsupported(context, element) {
    unsupportedCount += 1;
    warnings.add('UNSUPPORTED_ELEMENTS');
    append('[지원하지 않는 요소]', context, element, 'unsupported');
  }

  function elements(content, context, depth = 0) {
    if (depth > 40) throw failure('SOURCE_TOO_LARGE');
    for (const structural of content || []) {
      if (++visited > 200_000) throw failure('SOURCE_TOO_LARGE');
      if (structural.paragraph) {
        for (const element of structural.paragraph.elements || []) {
          if (element.textRun && typeof element.textRun.content === 'string') {
            append(element.textRun.content, context, element);
            const link = element.textRun.textStyle?.link?.url;
            if (typeof link === 'string' && link && !element.textRun.content.includes(link)) {
              append(` [${link}]`, context, {}, 'link');
            }
          } else if (element.footnoteReference) {
            append(`[각주:${element.footnoteReference.footnoteId || '?'}]`, context, element, 'footnote-reference');
          } else if (element.pageBreak || element.columnBreak || element.horizontalRule) {
            append('\n', context, element, 'separator');
          } else {
            unsupported(context, element);
          }
        }
      } else if (structural.table) {
        append('\n[표]\n', context, {}, 'separator');
        for (const row of structural.table.tableRows || []) {
          const cells = row.tableCells || [];
          cells.forEach((cell, index) => {
            if (index) append('\t', context, {}, 'separator');
            elements(cell.content, context, depth + 1);
          });
          append('\n', context, {}, 'separator');
        }
      } else if (structural.tableOfContents) {
        elements(structural.tableOfContents.content, context, depth + 1);
      } else if (!structural.sectionBreak) {
        unsupported(context, structural);
      }
    }
  }

  function tabContents(tab, depth = 0) {
    if (depth > 20 || ++tabCount > 1_000) throw failure('SOURCE_TOO_LARGE');
    const tabId = tab.tabProperties?.tabId ?? null;
    const content = tab.documentTab;
    if (!content) {
      unsupported({ tabId }, {});
    } else {
      if (tabCount > 1) append('\n', { tabId }, {}, 'separator');
      elements(content.body?.content, { tabId });
      for (const [kind, label] of [['headers', '머리말'], ['footers', '꼬리말'], ['footnotes', '각주']]) {
        for (const [segmentId, segment] of Object.entries(content[kind] || {})) {
          append(`\n[${label}:${segmentId}]\n`, { tabId, segmentId }, {}, 'separator');
          elements(segment.content, { tabId, segmentId });
        }
      }
      if (Object.keys(content.positionedObjects || {}).length) {
        for (const _ of Object.keys(content.positionedObjects)) unsupported({ tabId }, {});
      }
    }
    for (const child of tab.childTabs || []) tabContents(child, depth + 1);
  }

  if (Array.isArray(doc.tabs) && doc.tabs.length) {
    for (const tab of doc.tabs) tabContents(tab);
  } else {
    warnings.add('LEGACY_SINGLE_TAB');
    tabContents({ documentTab: doc });
  }
  return {
    title: typeof doc.title === 'string' ? doc.title : '', text: pieces.join(''),
    tabCount, spans, warnings: [...warnings], unsupportedCount,
  };
}

export class GoogleDriveConnector {
  constructor({ clientId = '', apiKey = '', appId = '', fetchImpl = globalThis.fetch } = {}) {
    this.clientId = clientId;
    this.apiKey = apiKey;
    this.appId = String(appId);
    this._fetch = fetchImpl;
    this._accessToken = null;
    this._expiresAt = 0;
    this._connecting = null;
    this._connectionEpoch = 0;
    this._inputIds = new Set();
    this._saveQueue = Promise.resolve();
  }

  get isConnected() { return Boolean(this._accessToken && Date.now() < this._expiresAt); }

  async connect() {
    if (this.isConnected) return { connected: true };
    if (this._connecting) return this._connecting;
    if (!this.clientId || !this.apiKey || !this.appId) throw failure('SETUP_REQUIRED');
    const epoch = this._connectionEpoch;
    this._connecting = (async () => {
      if (!globalThis.google?.accounts?.oauth2) await loadScript('https://accounts.google.com/gsi/client');
      await new Promise((resolve, reject) => {
        let settled = false;
        const finish = (error) => {
          if (settled) return;
          settled = true;
          clearTimeout(timer);
          error ? reject(error) : resolve();
        };
        const timer = setTimeout(() => finish(failure('AUTH_CANCELLED')), 120_000);
        timer.unref?.();
        try {
          const oauth = globalThis.google.accounts.oauth2;
          const client = oauth.initTokenClient({
            client_id: this.clientId, scope: DRIVE_FILE, include_granted_scopes: false,
            callback: response => {
              if (settled) return;
              if (epoch !== this._connectionEpoch) { finish(failure('AUTH_CANCELLED')); return; }
              if (response?.error || typeof response?.access_token !== 'string' || !response.access_token) {
                finish(failure('AUTH_REQUIRED')); return;
              }
              const scopes = typeof response.scope === 'string' ? response.scope.split(/\s+/) : null;
              if ((scopes && !scopes.includes(DRIVE_FILE)) ||
                  (oauth.hasGrantedAllScopes && !oauth.hasGrantedAllScopes(response, DRIVE_FILE))) {
                finish(failure('AUTH_REQUIRED')); return;
              }
              const seconds = Number(response.expires_in ?? 3600);
              if (!Number.isFinite(seconds) || seconds <= 0) { finish(failure('AUTH_REQUIRED')); return; }
              this._accessToken = response.access_token;
              this._expiresAt = Date.now() + seconds * 1000 - Math.min(5_000, seconds * 100);
              finish();
            },
            error_callback: () => finish(failure('AUTH_CANCELLED')),
          });
          client.requestAccessToken();
        } catch { finish(failure('AUTH_CANCELLED')); }
      });
      return { connected: true };
    })();
    try { return await this._connecting; } finally { this._connecting = null; }
  }

  disconnect() {
    this._connectionEpoch += 1;
    const token = this._accessToken;
    this._accessToken = null;
    this._expiresAt = 0;
    if (token && globalThis.google?.accounts?.oauth2?.revoke) {
      try { globalThis.google.accounts.oauth2.revoke(token, () => {}); } catch { /* Local disconnect still succeeds. */ }
    }
  }

  _token() {
    if (!this.isConnected) { this._accessToken = null; this._expiresAt = 0; throw failure('AUTH_REQUIRED'); }
    return this._accessToken;
  }

  async pickDocument() {
    const token = this._token();
    if (!globalThis.google?.picker) {
      if (!globalThis.gapi) await loadScript('https://apis.google.com/js/api.js');
      await new Promise((resolve, reject) => {
        globalThis.gapi.load('picker', {
          callback: resolve, onerror: () => reject(failure('SDK_LOAD_FAILED')),
          timeout: 30_000, ontimeout: () => reject(failure('SDK_LOAD_FAILED')),
        });
      });
    }
    return new Promise((resolve, reject) => {
      const picker = globalThis.google.picker;
      const view = new picker.DocsView(picker.ViewId.DOCS).setMimeTypes(DOC_MIME);
      const builder = new picker.PickerBuilder()
        .addView(view).setOAuthToken(token).setDeveloperKey(this.apiKey).setAppId(this.appId)
        .setCallback(data => {
          if (data.action === picker.Action.CANCEL) { reject(failure('AUTH_CANCELLED')); return; }
          if (data.action !== picker.Action.PICKED) return;
          const selected = data.docs?.[0];
          if (!validId(selected?.id) || selected.mimeType !== DOC_MIME) {
            reject(failure('UNSUPPORTED_DOCUMENT')); return;
          }
          this._inputIds.add(selected.id);
          resolve({ id: selected.id, name: selected.name || '', mimeType: selected.mimeType });
        });
      if (builder.setOrigin && globalThis.location?.origin) builder.setOrigin(location.origin);
      builder.build().setVisible(true);
    });
  }

  async _request(url, { method = 'GET', body, signal } = {}) {
    const token = this._token();
    if (signal?.aborted) throw failure('REQUEST_ABORTED');
    const headers = { Authorization: `Bearer ${token}` };
    if (body !== undefined) headers['Content-Type'] = 'application/json';
    let response;
    try {
      response = await this._fetch(url, { method, headers, body: body === undefined ? undefined : JSON.stringify(body), signal });
    } catch {
      throw failure(signal?.aborted ? 'REQUEST_ABORTED' : 'REQUEST_FAILED', { ambiguous: method !== 'GET' });
    }
    if (response.status === 401) {
      if (this._accessToken === token) { this._accessToken = null; this._expiresAt = 0; }
      throw failure('AUTH_REQUIRED', { status: 401 });
    }
    if (!response.ok) throw failure('HTTP_ERROR', { status: response.status, ambiguous: method !== 'GET' && response.status >= 500 });
    try { return await response.json(); }
    catch { throw failure('REQUEST_FAILED', { ambiguous: method !== 'GET' }); }
  }

  async _metadata(id, signal) {
    if (!validId(id)) throw failure('VALIDATION_ERROR');
    const fields = 'id,name,mimeType,modifiedTime,version,webViewLink,parents,appProperties';
    return this._request(`${DRIVE_API}/${id}?fields=${encodeURIComponent(fields)}`, { signal });
  }

  async readDocument(file) {
    if (!validId(file?.id)) throw failure('VALIDATION_ERROR');
    this._inputIds.add(file.id);
    const before = await this._metadata(file.id);
    if (before.mimeType !== DOC_MIME) throw failure('UNSUPPORTED_DOCUMENT');
    const doc = await this._request(`${DOCS_API}/${file.id}?includeTabsContent=true&suggestionsViewMode=PREVIEW_WITHOUT_SUGGESTIONS`);
    const extracted = extractGoogleDocument(doc);
    const after = await this._metadata(file.id);
    const changed = before.version !== after.version || before.modifiedTime !== after.modifiedTime;
    if (changed) extracted.warnings.push('SOURCE_CHANGED_DURING_READ');
    return {
      title: doc.title || before.name || file.name || '', text: extracted.text,
      source: {
        fileId: file.id, url: docUrl(file.id), version: before.version ?? null,
        versionBefore: before.version ?? null, versionAfter: after.version ?? null,
        revision: doc.revisionId ?? null, tabCount: extracted.tabCount,
        modifiedTime: before.modifiedTime ?? null, modifiedDuringRead: changed,
        fetchedAt: new Date().toISOString(), suggestionsPolicy: 'PREVIEW_WITHOUT_SUGGESTIONS',
        spans: extracted.spans,
      },
      warnings: extracted.warnings, unsupportedCount: extracted.unsupportedCount,
    };
  }

  /** List only this OAuth app's saved bundle folders. drive.file deliberately
   * does not turn this into a search across the user's entire Drive.
   */
  async listSaved({ pageSize = 20, pageToken } = {}) {
    if (!Number.isInteger(pageSize) || pageSize < 1 ||
        (pageToken != null && (typeof pageToken !== 'string' || pageToken.length > 4096 || /[\u0000-\u001F\u007F]/.test(pageToken)))) {
      throw failure('VALIDATION_ERROR');
    }
    const query = new URLSearchParams({
      q: `trashed = false and mimeType='${FOLDER_MIME}' and appProperties has { key='artifactRole' and value='bundle-folder' }`,
      pageSize: String(Math.min(100, pageSize)),
      orderBy: 'modifiedTime desc',
      fields: 'files(id,name,webViewLink,modifiedTime,appProperties),nextPageToken',
    });
    if (pageToken) query.set('pageToken', pageToken);
    const response = await this._request(`${DRIVE_API}?${query}`);
    if (response.files !== undefined && !Array.isArray(response.files)) throw failure('REQUEST_FAILED');
    const items = (response.files || [])
      .filter(file => validId(file?.id) && file.appProperties?.artifactRole === 'bundle-folder')
      .map(file => ({
        id: file.id,
        title: typeof file.name === 'string' ? file.name : '',
        url: folderUrl(file.id),
        modifiedAt: typeof file.modifiedTime === 'string' ? file.modifiedTime : null,
        runId: typeof file.appProperties.runId === 'string' ? file.appProperties.runId : null,
      }));
    return { items, nextPageToken: typeof response.nextPageToken === 'string' ? response.nextPageToken : null };
  }

  /** Recheck the imported Drive snapshot immediately before saving output.
   * This is a read-only comparison, not an atomic lock on the source document.
   * Local/file inputs have no Drive version to compare and require no grant.
   */
  async checkSourceVersion(source) {
    if (!source?.fileId) return { changed: false, version: null, modifiedTime: null };
    if (!validId(source.fileId)) throw failure('VALIDATION_ERROR');
    this._inputIds.add(source.fileId);
    const latest = await this._metadata(source.fileId);
    // Drive versions are uint64 strings. Never round them through Number.
    const storedVersion = source.version == null ? null : String(source.version);
    const version = latest.version == null ? null : String(latest.version);
    const storedTime = source.modifiedTime ?? null;
    const modifiedTime = latest.modifiedTime ?? null;
    const changed = storedVersion !== version || storedTime !== modifiedTime;
    return { changed, version, modifiedTime };
  }

  _assertWritable(id) {
    if (!validId(id)) throw failure('VALIDATION_ERROR');
    if (this._inputIds.has(id)) throw failure('SOURCE_WRITE_BLOCKED');
  }

  /** Serializes this connector instance. A caller can wrap this in a Web Lock
   * shared by tabs; appProperties are reconciliation markers, not unique keys.
   */
  saveBundle(options) {
    const pending = this._saveQueue.then(() => this._saveBundle(options));
    this._saveQueue = pending.catch(() => {});
    return pending;
  }

  async _checkpoint(ledger, onLedger) {
    try { await onLedger(copy(ledger)); }
    catch { throw failure('LEDGER_WRITE_FAILED'); }
  }

  _notify(onProgress, progress) {
    try { onProgress(progress); } catch { /* Rendering errors must not repeat a remote write. */ }
  }

  async _prepare({ runId, title, artifacts, sourceFileId, ledger = {} }) {
    if (typeof runId !== 'string' || !/^[A-Za-z0-9_-]{1,80}$/.test(runId) ||
        typeof title !== 'string' || !title.trim() || codepoints(title) > 200 ||
        !Array.isArray(artifacts) || !artifacts.length || artifacts.length > MAX_ARTIFACTS ||
        !ledger || typeof ledger !== 'object' || Array.isArray(ledger)) throw failure('VALIDATION_ERROR');
    if (sourceFileId !== undefined) {
      if (!validId(sourceFileId)) throw failure('VALIDATION_ERROR');
      this._inputIds.add(sourceFileId);
    }
    let total = 0;
    const keys = new Set();
    const prepared = [];
    for (const artifact of artifacts) {
      if (!artifact || typeof artifact.key !== 'string' || !/^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$/.test(artifact.key) ||
          keys.has(artifact.key) || typeof artifact.title !== 'string' || !artifact.title.trim() ||
          codepoints(artifact.title) > 200 || typeof artifact.text !== 'string' || !artifact.text.trim() ||
          artifact.text.length > 250_000 || /[\u0000-\u0008\u000B-\u001F\u007F]/.test(artifact.text)) throw failure('VALIDATION_ERROR');
      total += artifact.text.length;
      if (total > 2_000_000) throw failure('VALIDATION_ERROR');
      keys.add(artifact.key);
      prepared.push({ ...artifact, textHash: await sha256(artifact.text) });
    }
    const contentHash = await sha256(JSON.stringify([title, prepared.map(item => [item.key, item.title, item.textHash])]));
    if (ledger.runId && ledger.runId !== runId) throw failure('INVALID_LEDGER');
    if (ledger.contentHash && ledger.contentHash !== contentHash) throw failure('RUN_CONTENT_CHANGED');
    const result = { runId, contentHash, operations: Object.create(null) };
    const definitions = [{ key: '_folder', role: 'bundle-folder', title, textHash: null },
      ...prepared.map(item => ({ ...item, role: 'artifact' }))];
    for (const definition of definitions) {
      const operationId = await sha256(JSON.stringify([this.appId, runId, definition.key, definition.role]));
      const previous = Object.hasOwn(ledger.operations || {}, definition.key) ? ledger.operations[definition.key] : null;
      if (previous && (previous.operationId !== operationId || previous.role !== definition.role ||
          previous.textHash !== definition.textHash || (previous.fileId && !validId(previous.fileId)) ||
          !['PENDING', 'CREATING', 'CREATED', 'WRITING', 'VERIFIED', 'UNKNOWN', 'ERROR'].includes(previous.state))) throw failure('INVALID_LEDGER');
      result.operations[definition.key] = previous ? {
        operationId, role: definition.role, textHash: definition.textHash,
        state: previous.state || 'PENDING', fileId: previous.fileId || null,
        revision: previous.revision || null, writeRevision: previous.writeRevision || null,
        phase: previous.phase || null, errorCode: previous.errorCode || null,
      } : { operationId, role: definition.role, textHash: definition.textHash, state: 'PENDING', fileId: null };
    }
    return { ledger: result, artifacts: prepared };
  }

  _validateOwned(meta, operation, runId, parentId, mimeType) {
    this._assertWritable(meta.id);
    if ((operation.fileId && meta.id !== operation.fileId) || meta.mimeType !== mimeType || meta.appProperties?.operationId !== operation.operationId ||
        meta.appProperties?.artifactRole !== operation.role || meta.appProperties?.runId !== runId ||
        (parentId && !(meta.parents || []).includes(parentId))) throw failure('OWNERSHIP_MISMATCH');
    return meta;
  }

  async _findCreated(operation, runId, parentId, mimeType, signal) {
    const q = `trashed = false and appProperties has { key='operationId' and value='${operation.operationId}' }`;
    const query = new URLSearchParams({ q, pageSize: '100', fields: 'files(id,mimeType,parents,appProperties),nextPageToken' });
    const matches = await this._request(`${DRIVE_API}?${query}`, { signal });
    if (!Array.isArray(matches.files) || matches.files.length > 1 || matches.nextPageToken) throw failure('SAVE_UNKNOWN');
    if (!matches.files.length) return null;
    return this._validateOwned(matches.files[0], operation, runId, parentId, mimeType);
  }

  async _ensureCreated({ operation, runId, name, parentId, mimeType, ledger, onLedger, signal }) {
    if (operation.fileId) {
      return this._validateOwned(await this._metadata(operation.fileId, signal), operation, runId, parentId, mimeType);
    }
    const uncertain = ['CREATING', 'UNKNOWN', 'WRITING', 'VERIFIED', 'CREATED'].includes(operation.state);
    let existing;
    try { existing = await this._findCreated(operation, runId, parentId, mimeType, signal); }
    catch (error) {
      if (uncertain || safeCode(error) === 'SAVE_UNKNOWN') { operation.state = 'UNKNOWN'; operation.phase = 'create'; }
      throw error;
    }
    if (existing) {
      operation.fileId = existing.id;
      operation.state = 'CREATED';
      operation.errorCode = null;
      await this._checkpoint(ledger, onLedger);
      return existing;
    }
    if (uncertain) { operation.state = 'UNKNOWN'; operation.phase = 'create'; throw failure('SAVE_UNKNOWN'); }
    operation.state = 'CREATING';
    operation.phase = 'create';
    operation.errorCode = null;
    await this._checkpoint(ledger, onLedger);
    try {
      const created = await this._request(`${DRIVE_API}?fields=${encodeURIComponent('id,mimeType,parents,appProperties')}`, {
        method: 'POST', signal,
        body: {
          name, mimeType, ...(parentId ? { parents: [parentId] } : {}),
          appProperties: { operationId: operation.operationId, artifactRole: operation.role, runId },
        },
      });
      // Even a nominally successful response without an ID is indeterminate.
      if (!validId(created.id)) throw failure('REQUEST_FAILED', { ambiguous: true });
      this._assertWritable(created.id);
      operation.fileId = created.id;
      operation.state = 'CREATED';
      operation.phase = null;
      await this._checkpoint(ledger, onLedger);
      return this._validateOwned(await this._metadata(created.id, signal), operation, runId, parentId, mimeType);
    } catch (error) {
      if (operation.fileId) throw error;
      if (!error.ambiguous) { operation.state = 'ERROR'; throw error; }
      operation.state = 'UNKNOWN';
      operation.errorCode = safeCode(error);
      await this._checkpoint(ledger, onLedger);
      if (signal?.aborted) throw failure('SAVE_UNKNOWN');
      try {
        existing = await this._findCreated(operation, runId, parentId, mimeType, signal);
      } catch { throw failure('SAVE_UNKNOWN'); }
      if (!existing) throw failure('SAVE_UNKNOWN');
      operation.fileId = existing.id;
      operation.state = 'CREATED';
      operation.phase = null;
      operation.errorCode = null;
      await this._checkpoint(ledger, onLedger);
      return existing;
    }
  }

  async _readOutput(id, signal) {
    return this._request(`${DOCS_API}/${id}?includeTabsContent=true&suggestionsViewMode=SUGGESTIONS_INLINE`, { signal });
  }

  _output(doc) {
    if (!Array.isArray(doc.tabs) || doc.tabs.length !== 1 || doc.tabs[0].childTabs?.length) throw failure('REMOTE_CONFLICT');
    const tab = doc.tabs[0];
    const tabId = tab.tabProperties?.tabId;
    if (!tabId || typeof doc.revisionId !== 'string' || !doc.revisionId) throw failure('REMOTE_CONFLICT');
    const extracted = extractGoogleDocument(doc);
    if (extracted.unsupportedCount || extracted.spans.some(span => !['text'].includes(span.kind))) throw failure('REMOTE_CONFLICT');
    return { tabId, revision: doc.revisionId, text: extracted.text };
  }

  async _writeArtifact({ operation, artifact, ledger, onLedger, signal }) {
    this._assertWritable(operation.fileId);
    let remote = this._output(await this._readOutput(operation.fileId, signal));
    const matches = value => value.text === `${artifact.text}\n`;
    const verified = async value => {
      operation.state = 'VERIFIED';
      operation.phase = null;
      operation.revision = value.revision;
      operation.errorCode = null;
      await this._checkpoint(ledger, onLedger);
    };
    if (matches(remote)) { await verified(remote); return; }
    if (operation.state === 'VERIFIED' || remote.text !== '\n' ||
        (operation.writeRevision && operation.writeRevision !== remote.revision)) throw failure('REMOTE_CONFLICT');
    operation.state = 'WRITING';
    operation.phase = 'write';
    operation.writeRevision = remote.revision;
    await this._checkpoint(ledger, onLedger);
    try {
      this._assertWritable(operation.fileId);
      await this._request(`${DOCS_API}/${operation.fileId}:batchUpdate`, {
        method: 'POST', signal,
        body: {
          writeControl: { requiredRevisionId: remote.revision },
          requests: [{ insertText: { location: { index: 1, tabId: remote.tabId }, text: artifact.text } }],
        },
      });
    } catch (error) {
      if (!error.ambiguous) { operation.state = 'ERROR'; throw error; }
      operation.state = 'UNKNOWN';
      operation.errorCode = safeCode(error);
      await this._checkpoint(ledger, onLedger);
      if (signal?.aborted) throw failure('SAVE_UNKNOWN');
      try { remote = this._output(await this._readOutput(operation.fileId, signal)); }
      catch { throw failure('SAVE_UNKNOWN'); }
      if (matches(remote)) { await verified(remote); return; }
      throw failure('SAVE_UNKNOWN');
    }
    // A successful insert is not final until the server content is read back.
    operation.state = 'UNKNOWN';
    await this._checkpoint(ledger, onLedger);
    try { remote = this._output(await this._readOutput(operation.fileId, signal)); }
    catch { throw failure('SAVE_UNKNOWN'); }
    if (!matches(remote)) throw failure('REMOTE_CONFLICT');
    await verified(remote);
  }

  async _saveBundle({ runId, title, artifacts, sourceFileId, ledger: previous = {}, onLedger = async () => {}, signal, onProgress = () => {} } = {}) {
    const prepared = await this._prepare({ runId, title, artifacts, sourceFileId, ledger: previous });
    const ledger = prepared.ledger;
    const results = prepared.artifacts.map(item => ({ key: item.key, id: null, url: null, status: 'PENDING' }));
    const folder = ledger.operations._folder;
    const finish = () => {
      const unknown = Object.values(ledger.operations).some(operation => operation.state === 'UNKNOWN');
      return {
        folderId: folder.fileId, folderUrl: folder.fileId ? folderUrl(folder.fileId) : null,
        artifacts: results, ledger: copy(ledger),
        status: unknown ? 'SAVE_UNKNOWN' : results.every(result => result.status === 'SAVED') ? 'SAVED' : 'SAVE_PARTIAL',
      };
    };
    const recordError = async (operation, error) => {
      if (operation.state !== 'UNKNOWN') operation.state = 'ERROR';
      operation.errorCode = safeCode(error);
      try { await this._checkpoint(ledger, onLedger); } catch { /* Return the current in-memory ledger to the caller. */ }
    };
    try {
      this._notify(onProgress, { stage: 'folder', status: 'SAVING', completed: 0, total: results.length });
      await this._ensureCreated({ operation: folder, runId, name: title, mimeType: FOLDER_MIME, ledger, onLedger, signal });
    } catch (error) {
      await recordError(folder, error);
      this._notify(onProgress, { stage: 'folder', status: folder.state, errorCode: safeCode(error) });
      return finish();
    }
    for (let index = 0; index < prepared.artifacts.length; index += 1) {
      const artifact = prepared.artifacts[index];
      const operation = ledger.operations[artifact.key];
      const result = results[index];
      try {
        this._notify(onProgress, { stage: 'artifact', key: artifact.key, status: 'SAVING', completed: index, total: results.length });
        await this._ensureCreated({ operation, runId, name: artifact.title, parentId: folder.fileId, mimeType: DOC_MIME, ledger, onLedger, signal });
        await this._writeArtifact({ operation, artifact, ledger, onLedger, signal });
        result.status = 'SAVED';
      } catch (error) {
        await recordError(operation, error);
        result.status = operation.state === 'UNKNOWN' ? 'UNKNOWN' : 'FAILED';
        result.errorCode = safeCode(error);
      }
      result.id = operation.fileId;
      result.url = operation.fileId ? docUrl(operation.fileId) : null;
      this._notify(onProgress, { stage: 'artifact', key: artifact.key, status: result.status, completed: index + 1, total: results.length, ...(result.errorCode ? { errorCode: result.errorCode } : {}) });
      if (signal?.aborted || !this.isConnected) break;
    }
    return finish();
  }
}
