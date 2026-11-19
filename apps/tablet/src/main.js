import './style.css';
import { summarize, refine } from './core/summary/engine.js';
import { outboundSummary } from './core/summary/output.js';
import { boardMarkup, bindBoard } from './core/summary/board.js';
import { maskOutbound } from './core/masking.js';
import { privacyMarkup } from './core/privacy-panel.js';
import { GoogleDriveConnector } from './drive/google-drive.js';
import { BrowserGenerator } from './model/generator.js';
import { readSettings, writeSettings, RecoveryStore } from './storage.js';
import { syntheticResearch } from './demo.js';

const $ = selector => document.querySelector(selector);
const esc = value => String(value ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);
const length = value => [...String(value || '')].length;
const format = value => new Intl.NumberFormat('ko-KR', { maximumFractionDigits: 1 }).format(value || 0);
const terms = value => String(value).split(/[,\n]/).map(x => x.trim()).filter(Boolean);
const stored = readSettings();
const config = {
  clientId: stored.clientId || import.meta.env.VITE_GOOGLE_CLIENT_ID || '',
  apiKey: stored.apiKey || import.meta.env.VITE_GOOGLE_API_KEY || '',
  appId: stored.appId || import.meta.env.VITE_GOOGLE_APP_ID || '',
};
const state = {
  title: '', text: '', source: {}, warnings: [], unsupported: 0,
  first: null, second: null, busy: false, dirty: false, message: '', error: false,
  privacyEnabled: true, maskTerms: '', keepTerms: '', maskReview: false, modelFile: null,
  pendingOutboundRun: null, thresholds: {}, maskOverflowApproval: '', recovery: false, history: [], saved: [], nextPage: null, settingsOpen: false,
};
const store = new RecoveryStore();
let drive = new GoogleDriveConnector(config);
let controller;
let generator;

const mask = value => state.privacyEnabled ? maskOutbound(value, { terms: terms(state.maskTerms) }).text : String(value ?? '');
const outbound = run => outboundSummary(run, terms(state.maskTerms), state.privacyEnabled);
const summary = run => outbound(run).text;
const currentRun = () => state.second?.status === 'OK' ? state.second : state.first?.status === 'OK' ? state.first : null;
const latestRun = () => state.second || state.first;

function message(value, error = false) {
  state.message = value; state.error = error;
  const el = $('#status');
  if (el) { el.textContent = value; el.className = error ? 'status error' : 'status'; }
}

function resultMeta(run, text) {
  if (!run) return '아직 요약하지 않았습니다.';
  return `${format(length(text))}자 / 상한 ${run.metrics.budget}자 · 원문 대비 ${format(length(text) / (run.metrics.sourceCodepoints || 1) * 100)}% · ${run.report.engine.methodUsed.join(', ') || '결과 없음'}`;
}
function resultPane(run, stage) {
  const output = summary(run);
  return `<section class="pane"><div class="pane-heading"><h2>요약 ${stage}</h2><button class="small" data-copy="${stage}" ${run?.status !== 'OK' || state.busy ? 'disabled' : ''}>복사</button></div><textarea id="summary-${stage}" readonly aria-label="요약 ${stage} 결과" placeholder="${stage === 1 ? '300자·원문 1/3 이하의 요약 본문' : '1차보다 짧은 요약 본문'}">${esc(output)}</textarea><div class="pane-meta">${esc(resultMeta(run, output))}</div></section>`;
}

function settingsMarkup() {
  return `<details class="settings" ${state.settingsOpen ? 'open' : ''}><summary>설정</summary><div class="settings-grid"><div><label for="keep-terms">보존할 단어</label><input id="keep-terms" value="${esc(state.keepTerms)}" placeholder="쉼표로 구분"/><label class="check"><input type="checkbox" id="recover" ${state.recovery ? 'checked' : ''}/> 이 기기에 작업 보관 (원문 근거 포함)</label>${state.history.length ? `<label for="restore">보관한 작업</label><select id="restore"><option value="">작업 선택</option>${state.history.filter(run => run.schema === 'pts.summary/v1').map((run, i) => `<option value="${i}">${esc(run.title)} · 요약 ${run.stage || 1}</option>`).join('')}</select>` : ''}</div><div><details><summary>선택: 내 기기의 AI 모델</summary><p class="help">기본은 예산 안에서 문장을 고르는 압축 발췌입니다. 호환 .litertlm 파일을 선택하면 AI 요약을 생성하고 규칙 검사 후 채택합니다. 외부 유료 API는 호출하지 않습니다.</p><input type="file" id="model-file" accept=".litertlm" aria-label="로컬 AI 모델 파일"/><p class="help">${state.modelFile ? esc(state.modelFile.name) : '모델 파일을 선택하지 않았습니다.'}</p></details><details class="operator"><summary>운영자: Google 연결 설정</summary><form id="google-settings"><label for="client-id">OAuth 웹 클라이언트 ID</label><input id="client-id" name="clientId" value="${esc(config.clientId)}"/><label for="api-key">Picker API key</label><input id="api-key" name="apiKey" value="${esc(config.apiKey)}" autocomplete="off"/><label for="app-id">프로젝트 번호</label><input id="app-id" name="appId" value="${esc(config.appId)}"/><p class="help">공개 배포 시 운영자가 한 번 설정합니다. 비밀키·로그인 토큰을 입력하지 마세요.</p><button class="small" type="submit">공개 설정 저장</button></form></details><button class="small disconnect" id="disconnect">Google 연결 해제</button></div></div></details>`;
}

function render() {
  const locked = state.busy ? 'disabled' : '';
  $('#app').innerHTML = `<main><header><h1>prompt token saver <span>: 토큰을 아끼세요</span><sup class="beta">Beta · Brief 1.0</sup><img class="lumi" src="./lumi.svg" alt="루미 노랑이" width="76" height="81"/></h1><button class="small" id="demo" ${locked}>예제</button></header>
    ${privacyMarkup(state)}
    <div class="document-row"><label for="title">제목</label><input id="title" value="${esc(state.title)}" maxlength="160" placeholder="저장할 문서 제목" ${locked}/><button class="small" id="drive-input" ${locked}>Drive에서 가져오기</button><label class="file-button">파일<input type="file" id="source-file" accept=".txt,.md,text/plain,text/markdown" hidden ${locked}/></label></div>
    <div class="panes"><section class="pane"><div class="pane-heading"><h2>원문 붙여넣기</h2><div class="pane-tools"><button class="small" id="copy-source" ${locked}>복사</button><button class="small" id="paste-source" ${locked}>붙여넣기</button><button class="small" id="clear-source" ${locked}>전체 지우기</button></div></div><textarea id="source" aria-label="요약할 원문" placeholder="요약할 프롬프트나 리서치 내용을 그대로 붙여넣으세요." ${locked}>${esc(state.text)}</textarea><div class="pane-meta" id="source-count">${format(length(state.text))}자 · 약 ${format(length(state.text) / 1500)}쪽</div></section>${resultPane(state.first, 1)}${resultPane(state.second, 2)}</div>
    <div class="actions"><button class="primary" id="summarize-first" ${locked}>요약하기 1</button><span class="action-arrow" aria-hidden="true">→</span><button class="primary" id="summarize-second" ${state.first?.status !== 'OK' || state.dirty || state.busy ? 'disabled' : ''}>필터로 요약하기 2</button><span class="action-arrow" aria-hidden="true">→</span><button id="drive-save" ${!currentRun() || state.dirty || state.busy ? 'disabled' : ''}>Google Drive에 저장</button>${state.busy && controller ? '<button class="small" id="cancel">중단</button>' : ''}</div>
    <p id="status" class="status ${state.error ? 'error' : ''}" role="status" aria-live="polite">${esc(state.message || '요약은 300자·원문 1/3 이하입니다. 선택한 문장의 관계를 검사하며 빠진 내용은 판정 보드에서 확인하세요.')}</p>
    ${state.maskReview ? '<p class="warning">복구한 작업의 개인 단어 가리기를 설정에서 확인한 뒤 복사·저장해 주세요.</p>' : ''}
    ${(state.pendingOutboundRun || currentRun()) && outbound(state.pendingOutboundRun || currentRun()).overBudget ? '<p class="warning">가리기 적용 후 상한을 넘었습니다. 내용을 확인한 뒤 <button id="approve-mask-overflow" class="small">이 가리기 결과의 복사·저장 허용</button></p>' : ''}
    ${boardMarkup(latestRun(), state.thresholds, mask)}
    <section class="saved-section"><div class="saved-heading"><h2>저장 목록</h2><button class="small" id="refresh-saved" ${locked}>Drive 목록 불러오기</button></div><div class="table-wrap"><table><thead><tr><th>제목</th><th>저장·수정 시각</th><th>열기</th></tr></thead><tbody>${state.saved.length ? state.saved.map(item => `<tr><td>${esc(item.title)}</td><td>${esc(dateText(item.modifiedAt))}</td><td><a href="${esc(driveUrl(item.id))}" target="_blank" rel="noopener noreferrer">Drive 열기 ↗</a></td></tr>`).join('') : '<tr><td colspan="3" class="empty">저장한 문서를 여기에 표시합니다.</td></tr>'}</tbody></table></div>${state.nextPage ? `<button class="small more" id="more-saved" ${locked}>더 불러오기</button>` : ''}</section>${settingsMarkup()}
    <p class="footnote">Brief 1.0 · 요약 상한 300자·원문 1/3 · 입력과 요약은 기기에서 처리합니다. Drive는 로그인 후 선택한 자료만 사용합니다.</p></main>`;
  bind();
}

function dateText(value) { try { return value ? new Date(value).toLocaleString('ko-KR', { timeZone: 'Asia/Seoul', dateStyle: 'short', timeStyle: 'short' }) : '—'; } catch { return '—'; } }
function driveUrl(id) { return `https://drive.google.com/drive/folders/${encodeURIComponent(id)}`; }

function bind() {
  document.querySelectorAll('.settings input, .settings select, .settings button, .privacy-panel input, .privacy-panel button').forEach(element => { element.disabled = state.busy; });
  $('#title').addEventListener('input', event => { state.title = event.target.value; markDirty(); });
  $('#source').addEventListener('input', event => { state.text = event.target.value; state.source = {}; state.unsupported = 0; state.warnings = []; markDirty(); $('#source-count').textContent = `${format(length(state.text))}자 · 약 ${format(length(state.text) / 1500)}쪽`; });
  $('#copy-source').addEventListener('click', copySource);
  $('#paste-source').addEventListener('click', pasteSource);
  $('#mask-terms').disabled = state.busy || !state.privacyEnabled;
  $('#privacy-enabled').addEventListener('change', event => {
    state.privacyEnabled = event.target.checked;
    state.maskReview = false; state.maskOverflowApproval = ''; state.pendingOutboundRun = null;
    render();
  });
  $('#clear-source').addEventListener('click', () => {
    if (state.busy) return;
    const field = $('#source');
    field.value = '';
    field.dispatchEvent(new Event('input', { bubbles: true }));
    field.focus();
    message('원문을 모두 지웠습니다. 새 원문을 붙여넣고 요약하기 1을 실행해 주세요.');
  });
  $('#summarize-first').addEventListener('click', () => process(1));
  $('#summarize-second').addEventListener('click', () => process(2));
  $('#cancel')?.addEventListener('click', () => { controller?.abort(); generator?.cancel(); message('중단 요청 · 실행 자원을 정리하고 있습니다.'); });
  $('#demo').addEventListener('click', () => { Object.assign(state, syntheticResearch(), { source: {}, unsupported: 0, warnings: [], dirty: Boolean(state.first) }); render(); message('실제 개인정보가 없는 약 35쪽 합성 예제입니다. 요약하기 1을 눌러 보세요.'); });
  $('#source-file').addEventListener('change', event => importFile(event.target.files[0]));
  $('#drive-input').addEventListener('click', importDrive);
  $('#drive-save').addEventListener('click', saveDrive);
  $('#refresh-saved').addEventListener('click', () => refreshSaved(false));
  $('#more-saved')?.addEventListener('click', () => refreshSaved(true));
  document.querySelectorAll('[data-copy]').forEach(button => button.addEventListener('click', () => copySummary(Number(button.dataset.copy))));
  $('#keep-terms').addEventListener('input', event => { state.keepTerms = event.target.value; markDirty(); });
  $('#mask-terms').addEventListener('input', event => { state.maskTerms = event.target.value; state.maskReview = false; state.maskOverflowApproval = ''; updateSummaryPreview(); });
  $('#recover').addEventListener('change', async event => {
    state.recovery = event.target.checked;
    if (state.recovery && currentRun()) try { await persist(currentRun()); message('현재 결과를 이 기기에 보관했습니다.'); } catch (error) { message(errorText(error), true); }
  });
  $('#restore')?.addEventListener('change', event => { if (state.busy || !event.target.value) return; const run = structuredClone(state.history[Number(event.target.value)]); if (run.schema !== 'pts.summary/v1') return; state.first = run.stage === 2 ? null : run; state.second = run.stage === 2 ? run : null; state.title = run.title; state.text = ''; state.source = {}; state.dirty = false; state.maskReview = Boolean(run.usedCustomMasking); render(); message('보관한 요약을 열었습니다. 원문은 별도로 가져올 수 있습니다.'); });
  $('#google-settings').addEventListener('submit', event => { event.preventDefault(); if (state.busy) return; try { Object.assign(config, writeSettings(Object.fromEntries(new FormData(event.target)))); drive.disconnect(); drive = new GoogleDriveConnector(config); message('공개 연결 설정을 저장했습니다.'); } catch (error) { message(errorText(error), true); } });
  $('#disconnect').addEventListener('click', () => { drive.disconnect(); state.saved = []; state.nextPage = null; render(); message('Google 연결을 해제했습니다. 현재 요약은 유지됩니다.'); });
  $('#approve-mask-overflow')?.addEventListener('click', () => { state.maskOverflowApproval = summary(state.pendingOutboundRun || currentRun()); state.pendingOutboundRun = null; message('확인한 가리기 결과의 복사·저장을 허용했습니다.'); });
  bindDecisionBoard();
  $('#model-file').addEventListener('change', event => { state.modelFile = event.target.files[0] || null; message(state.modelFile ? '선택한 로컬 모델을 다음 요약에 사용합니다. 외부 AI로 보내지 않습니다.' : '모델 없이 무료 원문 발췌로 처리합니다.'); });
  $('.settings').addEventListener('toggle', event => { state.settingsOpen = event.target.open; });
}

function bindDecisionBoard() {
  bindBoard($('#app'), latestRun(), { keepTerms: terms(state.keepTerms), onThresholds: values => { state.thresholds = values; }, onRerun: values => { if (!state.busy) { state.thresholds = values; process(1); } } });
}

function updateSummaryPreview() {
  for (const [stage, run] of [[1, state.first], [2, state.second]]) {
    if (!run) continue;
    const field = $(`#summary-${stage}`);
    const text = summary(run);
    field.value = text;
    field.nextElementSibling.textContent = resultMeta(run, text);
  }
  const board = $('.decision-board');
  if (board) {
    const open = board.open;
    board.outerHTML = boardMarkup(latestRun(), state.thresholds, mask);
    $('.decision-board').open = open;
    bindDecisionBoard();
  }
}

function markDirty() {
  state.dirty = Boolean(state.first || state.second);
  if (state.dirty) { $('#summarize-second').disabled = true; $('#drive-save').disabled = true; message('입력이 바뀌었습니다. 요약하기 1을 다시 눌러 주세요.'); }
}

async function persist(run) {
  if (!state.recovery) return;
  run.usedCustomMasking ||= terms(state.maskTerms).length > 0;
  await store.put(run);
  state.history = (await store.list()).filter(run => run.schema === 'pts.summary/v1');
}

async function process(stage) {
  if (state.busy) return;
  if (stage === 1 && !state.text.trim()) { $('#source').focus(); return message('요약할 내용을 붙여넣어 주세요.', true); }
  if (length(state.text) > 500_000) return message('50만 자 이하의 텍스트를 넣어 주세요.', true);
  if (stage === 2 && (state.first?.status !== 'OK' || state.dirty)) return;
  controller = new AbortController(); state.busy = true; render();
  const progress = value => message(typeof value === 'string' ? value : value?.message || `${stage === 1 ? '요약 1' : '필터로 요약 2'} 처리 중${value?.total ? ` · ${value.completed || 0}/${value.total}` : ''}`);
  try {
    if (state.modelFile) { generator = new BrowserGenerator({ onStatus: progress }); await generator.load({ file: state.modelFile, signal: controller.signal }); }
    const options = { text: state.text, keepTerms: terms(state.keepTerms), signal: controller.signal, onProgress: progress, generator, thresholds: state.thresholds };
    const run = stage === 1 ? await summarize(state.text, options) : await refine(state.first, options);
    if (run.status === 'ABORTED' || controller.signal.aborted) throw new DOMException('중단', 'AbortError');
    Object.assign(run, { id: crypto.randomUUID(), createdAt: new Date().toISOString(), title: state.title || '프롬프트 요약', source: structuredClone(state.source), appVersion: 'brief-1.0.0', usedCustomMasking: terms(state.maskTerms).length > 0 });
    if (state.unsupported || state.source.modifiedDuringRead) run.report.warnings.push(...state.warnings, 'SOURCE_PARTIAL: 원문에서 지원되지 않는 요소 또는 읽기 중 변경이 있습니다.');
    if (stage === 1) { state.first = run; state.second = null; state.dirty = false; }
    else state.second = run;
    state.maskReview = false; state.pendingOutboundRun = null; state.maskOverflowApproval = '';
    await persist(run);
    const failures = { SOURCE_TOO_SHORT: '원문이 너무 짧습니다. 120자 이상 입력해 주세요.', BUDGET_UNSATISFIABLE: '의미를 유지하면서 예산 안에 담을 문장이 없습니다.', FAILED: run.report.warnings.includes('SOURCE_CHANGED') ? '원문이 바뀌었습니다. 요약하기 1을 다시 실행해 주세요.' : '검사를 통과한 요약을 만들지 못했습니다. 판정 보드를 확인해 주세요.', NOT_REDUCIBLE: '더 줄이면 핵심 관계가 깨집니다. 1차 결과를 유지합니다.' };
    message(run.status === 'OK' ? `요약 ${stage} 완료 · ${resultMeta(run, summary(run))}` : failures[run.status] || run.status, run.status !== 'OK');
  } catch (error) { message(error.name === 'AbortError' ? '중단했습니다. 원문과 기존 결과는 유지됩니다.' : errorText(error), error.name !== 'AbortError'); }
  finally { if (generator) { try { await generator.dispose(); } catch { message('모델 정리를 확인하지 못했습니다. 다시 사용하려면 이 탭을 닫아 주세요.', true); } generator = null; } controller = null; state.busy = false; render(); }
}

function maskingReady() {
  if (!state.maskReview || !state.privacyEnabled) return true;
  render(); $('#mask-terms').focus(); message('상단 개인정보 마스킹에서 가릴 단어를 확인한 뒤 복사·저장해 주세요.', true); return false;
}

async function copySource() {
  if (state.busy) return;
  try {
    await navigator.clipboard.writeText(mask(state.text));
    message(state.privacyEnabled ? '개인정보를 가린 원문을 복사했습니다.' : '원문을 복사했습니다.');
  } catch {
    $('#copy-fallback')?.remove();
    const field = document.createElement('textarea');
    field.id = 'copy-fallback'; field.className = 'copy-fallback'; field.readOnly = true;
    field.setAttribute('aria-label', '복사할 내용'); field.value = mask(state.text);
    $('#status').after(field);
    field.focus(); field.select(); field.setSelectionRange(0, field.value.length);
    message('복사할 내용을 전체 선택했습니다. Ctrl+C 또는 기기의 복사 메뉴를 사용해 주세요.');
  }
}

async function pasteSource() {
  if (state.busy) return;
  try {
    const text = await navigator.clipboard.readText();
    if (state.busy) return;
    const field = $('#source');
    // Insert at the selection, preserving the rest of the current source.
    field.setRangeText(text, field.selectionStart, field.selectionEnd, 'end');
    field.dispatchEvent(new Event('input', { bubbles: true }));
    field.focus();
    message(state.dirty ? '붙여넣었습니다. 입력이 바뀌어 요약하기 1을 다시 실행해야 합니다.' : '원문에 붙여넣었습니다.');
  } catch {
    $('#source').focus();
    message('클립보드 읽기 권한을 확인해 주세요. 입력란에서 Ctrl+V 또는 기기의 붙여넣기 메뉴도 사용할 수 있습니다.');
  }
}

async function copySummary(stage) {
  const run = stage === 1 ? state.first : state.second;
  if (run?.status !== 'OK' || !maskingReady() || !outboundReady(run)) return;
  try { await navigator.clipboard.writeText(summary(run)); message(`요약 ${stage}를 복사했습니다. Gemini·Codex·Claude 등 원하는 서비스에 붙여넣으세요.`); }
  catch {
    const field = $(`#summary-${stage}`);
    field.focus(); field.select(); field.setSelectionRange(0, field.value.length);
    let copied = false;
    try { copied = document.execCommand('copy'); } catch { /* Leave the result selected for native mobile copy. */ }
    message(copied ? '결과를 복사했습니다.' : '요약을 전체 선택했습니다. 길게 눌러 복사 메뉴를 사용해 주세요.', !copied);
  }
}

function outboundReady(run) {
  const artifact = outbound(run);
  if (!artifact.overBudget || state.maskOverflowApproval === artifact.text) return true;
  message(`가리기 결과 ${artifact.codepoints}자가 상한 ${run.metrics.budget}자를 넘습니다. 가리기 내용을 검토한 뒤 요약 아래의 허용 버튼을 눌러 주세요.`, true);
  state.pendingOutboundRun = run;
  render();
  return false;
}

function configured() {
  if (config.clientId && config.apiKey && config.appId) return true;
  state.settingsOpen = true; render(); $('.operator').open = true;
  message('아직 앱의 Google 연결 설정이 없습니다. 운영자가 공개 설정을 구성하면 사용할 수 있습니다.', true); return false;
}

async function importDrive() {
  if (state.busy || !configured()) return;
  state.busy = true; render();
  try {
    await drive.connect(); const file = await drive.pickDocument(); if (!file) return;
    const document = await drive.readDocument(file);
    if (length(document.text) > 500_000) throw new Error('50만 자 이하의 자료를 선택해 주세요.');
    Object.assign(state, { title: document.title, text: document.text, source: document.source, warnings: document.warnings || [], unsupported: document.unsupportedCount || 0, dirty: Boolean(state.first || state.second) });
    message(document.unsupportedCount ? '자료를 읽었습니다. 지원되지 않는 원문 요소가 있어 검토가 필요합니다.' : '자료를 가져왔습니다. 입력 원문은 수정하지 않았습니다.');
  } catch (error) { message(errorText(error), true); }
  finally { state.busy = false; render(); }
}

async function importFile(file) {
  if (!file || state.busy) return;
  try {
    if (!/\.(txt|md)$/i.test(file.name) || file.size > 3_000_000) throw new Error('3MB 이하 UTF-8 .txt 또는 .md 파일을 선택해 주세요.');
    const text = new TextDecoder('utf-8', { fatal: true }).decode(await file.arrayBuffer());
    if (length(text) > 500_000) throw new Error('50만 자 이하의 자료를 선택해 주세요.');
    Object.assign(state, { title: file.name.replace(/\.[^.]+$/, ''), text, source: {}, warnings: [], unsupported: 0, dirty: Boolean(state.first || state.second) }); render(); message('텍스트 파일을 가져왔습니다.');
  } catch (error) { message(errorText(error), true); }
}

async function saveDrive() {
  const run = currentRun();
  if (state.busy || !run || state.dirty || !maskingReady() || !outboundReady(run) || !configured()) return;
  state.busy = true; render(); message(`요약 ${run.stage || 1}을 Drive에 저장하고 있습니다.`);
  try {
    if (!drive.isConnected) await drive.connect();
    const version = await drive.checkSourceVersion(run.source || {});
    if (version.changed) { const error = new Error('원문이 요약 후 바뀌었습니다. 다시 가져와 요약해 주세요.'); error.code = 'SOURCE_CHANGED'; throw error; }
    const artifact = { ...outbound(run), key: 'summary', title: mask(`${run.title} · 요약 ${run.stage || 1}`) };
    const save = () => drive.saveBundle({ runId: run.id, title: mask(`${run.title} · 요약 ${run.stage || 1}`), artifacts: [artifact], sourceFileId: run.source?.fileId, ledger: run.saveLedger || {}, onLedger: async ledger => { run.saveLedger = structuredClone(ledger); await persist(run); } });
    const result = navigator.locks ? await navigator.locks.request(`pts-save-${run.id}`, { ifAvailable: true }, lock => { if (!lock) throw new Error('다른 탭에서 저장 중입니다.'); return save(); }) : await save();
    run.driveSaveResult = result; await persist(run);
    if (result.status === 'SAVED') {
      state.saved = [{ id: result.folderId, title: mask(`${run.title} · 요약 ${run.stage || 1}`), modifiedAt: new Date().toISOString(), runId: run.id }, ...state.saved.filter(item => item.id !== result.folderId)];
      message(`요약 ${run.stage || 1}을 Drive에 저장했습니다.`);
    } else message(result.status === 'SAVE_UNKNOWN' ? '저장 응답을 확인하지 못했습니다. 다시 저장하면 기존 작업부터 확인합니다.' : '저장이 일부만 완료되었습니다. 다시 저장하면 누락 부분부터 확인합니다.', true);
  } catch (error) { message(errorText(error), true); }
  finally { state.busy = false; render(); }
}

async function refreshSaved(append) {
  if (state.busy || !configured()) return;
  state.busy = true; render();
  try { if (!drive.isConnected) await drive.connect(); const result = await drive.listSaved({ pageSize: 20, pageToken: append ? state.nextPage : undefined }); state.saved = append ? [...state.saved, ...result.items.filter(item => !state.saved.some(old => old.id === item.id))] : result.items; state.nextPage = result.nextPageToken; message('이 앱의 Drive 저장 폴더 목록입니다. 미완료 작업 폴더도 포함될 수 있습니다.'); }
  catch (error) { message(errorText(error), true); }
  finally { state.busy = false; render(); }
}

function errorText(error) {
  const messages = { AUTH_REQUIRED: 'Google 로그인이 만료되었습니다. 다시 연결해 주세요.', SOURCE_CHANGED: '원문이 요약 후 바뀌었습니다. Drive에서 다시 가져와 요약해 주세요.', RUN_CONTENT_CHANGED: '가리기 설정이나 내용이 바뀌었습니다. 요약을 다시 실행한 뒤 새 결과로 저장해 주세요.', LEDGER_WRITE_FAILED: '작업 보관에 실패했습니다. 브라우저 저장 공간을 확인해 주세요.' };
  return messages[error.code] || (error.message && !/Bearer|access_token|AIza|https?:\/\//i.test(error.message) ? error.message : '작업을 완료하지 못했습니다. 연결과 권한을 확인해 주세요.');
}

document.addEventListener('visibilitychange', () => { if (document.hidden && controller) { controller.abort(); generator?.cancel(); } });
window.addEventListener('beforeunload', event => { if (state.busy || (currentRun() && !state.recovery && currentRun().driveSaveResult?.status !== 'SAVED')) { event.preventDefault(); event.returnValue = ''; } });
render();
store.list().then(items => { state.history = items.filter(run => run.schema === 'pts.summary/v1'); if (!state.busy) render(); }).catch(() => {});
if (import.meta.env.PROD && 'serviceWorker' in navigator) navigator.serviceWorker.register(new URL('sw.js', document.baseURI), { scope: './' }).catch(() => {});
