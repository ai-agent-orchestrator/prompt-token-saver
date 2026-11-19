import { C } from './normalize.js';
import { checks, accepted } from './checks.js';
const esc = value => String(value ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);
export function boardMarkup(run, thresholds = {}) {
  if (!run?.report) return '';
  return `<details class="decision-board"><summary>판정 보드 · ${esc(run.status)} · 요약 ${run.stage}</summary>
    <p class="help">${esc(run.report.engine.version)} · 상수 ${esc(run.report.engine.constantsVersion)} · ${esc(run.report.engine.generatorId || '모델 미사용')} · 규칙 검사, 임계값 보정 전</p>
    <div class="board-controls"><label>발췌 의미 문턱값 <input id="extract-threshold" type="range" min="0" max="1" step="0.01" value="${thresholds['compressed-extractive'] ?? C.TAU_A_EXTRACT}"/><output id="extract-threshold-value">${thresholds['compressed-extractive'] ?? C.TAU_A_EXTRACT}</output></label>
    <label>모델 의미 문턱값 <input id="model-threshold" type="range" min="0" max="1" step="0.01" value="${thresholds.model ?? C.TAU_A_MODEL}"/><output id="model-threshold-value">${thresholds.model ?? C.TAU_A_MODEL}</output></label>
    <p id="board-preview" role="status">미리보기: 저장된 후보만 재판정합니다. 요약 본문은 바뀌지 않습니다.</p><button class="small" id="rerun-engine">이 문턱값으로 엔진 재실행</button></div>
    <div class="table-wrap"><table><thead><tr><th>주제 / 예산</th><th>후보와 검사 A·B·C</th><th>최종 판정</th></tr></thead><tbody>${run.report.groups.map(g => `<tr><td>${esc(g.title)}<br/>가중치 ${g.weight.toFixed(3)} · ${g.budget}자</td><td>${g.attempts.map(a => `<details><summary>${esc(a.method)} · ${esc(a.decision)}</summary><p class="board-candidate">${esc(a.candidate || '(빈 후보)')}</p><p>${['meaning', 'anchor', 'length'].map(name => `${name}: ${esc(a.checks[name]?.result || 'UNVERIFIED')} ${esc(a.checks[name]?.reason || '')}`).join('<br/>')}${a.reason ? `<br/>${esc(a.reason)}` : ''}</p></details>`).join('') || '시도하지 않음'}</td><td>${esc(g.status)}</td></tr>`).join('')}</tbody></table></div>
    <details><summary>누락 그룹 ${run.report.omittedGroups.length} · 앵커 ${run.report.omittedAnchors.length}</summary><ul>${run.report.omittedGroups.map(g => `<li>${esc(g.id)}: ${esc(g.reason)}</li>`).join('')}${run.report.omittedAnchors.map(a => `<li>${esc(a.sentenceId)}: ${esc(a.text)} · ${esc(a.reason)}</li>`).join('')}</ul></details>
    ${run.report.warnings.length ? `<p class="warning">${esc(run.report.warnings.join(' · '))}</p>` : ''}</details>`;
}
export function bindBoard(root, run, { keepTerms = [], onThresholds, onRerun }) {
  const extraction = root.querySelector('#extract-threshold'), model = root.querySelector('#model-threshold');
  if (!extraction || !model) return;
  let revision = 0;
  const values = () => ({ 'compressed-extractive': Number(extraction.value), model: Number(model.value) });
  const preview = async () => {
    const current = ++revision, thresholds = values();
    root.querySelector('#extract-threshold-value').textContent = extraction.value;
    root.querySelector('#model-threshold-value').textContent = model.value;
    onThresholds(thresholds);
    let pass = 0, total = 0;
    for (const g of run.report.groups) for (const a of g.attempts) {
      if (a.decision === 'error') continue;
      total++;
      if (accepted(await checks(a.candidate, g, a.method, g.budget, keepTerms, thresholds))) pass++;
    }
    if (current === revision && root.querySelector('#board-preview')) root.querySelector('#board-preview').textContent = `미리보기(본문 변경 없음): 후보 ${total}개 중 ${pass}개 통과. 적용하려면 엔진 재실행을 누르세요.`;
  };
  extraction.addEventListener('input', preview); model.addEventListener('input', preview);
  root.querySelector('#rerun-engine').addEventListener('click', () => onRerun(values()));
}
