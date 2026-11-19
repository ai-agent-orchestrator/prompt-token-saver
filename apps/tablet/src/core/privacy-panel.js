import { inspectPrivacy } from './masking.js';
import { MASKING_VERSION } from './privacy-guard.js';
const esc = value => String(value ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);
const terms = value => value.split(/[,\n]/u).map(t => t.trim()).filter(Boolean);
export function privacySummary(result) {
  const labels = { ID_NUMBER: '식별번호', EMAIL: '이메일', PHONE: '전화번호', ACCOUNT: '계좌번호', FINANCIAL: '카드·계좌번호', CUSTOM: '지정 단어' };
  return result.redactions ? `${result.redactions}곳 가림 · ${Object.entries(result.counts).map(([type, count]) => `${labels[type]} ${count}`).join(' · ')}` : '현재 규칙에 해당하는 개인정보 패턴이 없습니다.';
}
export function privacyMarkup(state) {
  const disabled = state.busy ? 'disabled' : '';
  return `<section class="privacy-panel" aria-labelledby="privacy-heading">
    <div class="privacy-heading"><h2 id="privacy-heading">개인정보 마스킹</h2><span class="privacy-badge">자동 가리기 켜짐</span><span class="privacy-local">내 기기에서 처리</span></div>
    <p class="privacy-description">원문은 유지하고, 요약·복사·Drive 저장에 가리기를 적용합니다. 전화번호·이메일·식별번호·계좌 패턴을 찾습니다.</p>
    <div class="privacy-controls"><div class="privacy-terms"><label for="mask-terms">추가로 가릴 이름·기관·주소</label><input id="mask-terms" value="${esc(state.maskTerms)}" placeholder="홍길동, 기관명, 주소처럼 가릴 단어를 쉼표로 구분" ${disabled}/></div><button id="preview-privacy" ${disabled}>원문 마스킹 미리보기</button><button id="copy-masked-source" ${disabled}>마스킹본 복사</button>${state.maskReview ? `<button class="small" id="confirm-mask" ${disabled}>가리기 설정 확인</button>` : ''}</div>
    <p class="privacy-help">이름·주소는 직접 지정해 주세요. 지정 단어는 현재 탭에서만 사용합니다.</p>
    <details id="privacy-preview" ${state.privacyPreview ? 'open' : ''}><summary>가린 원문 확인</summary><p id="privacy-count" role="status"></p><textarea id="masked-source" readonly aria-label="개인정보를 가린 원문" placeholder="원문을 넣으면 가리기 결과를 확인할 수 있습니다."></textarea></details>
    <span class="visually-hidden">마스킹 버전 ${MASKING_VERSION}</span>
  </section>`;
}
export function refreshPrivacy(root, state) {
  const input = root.querySelector('#source');
  const preview = root.querySelector('#privacy-preview');
  const buttons = [root.querySelector('#copy-masked-source'), root.querySelector('#preview-privacy')];
  for (const button of buttons) if (button) button.disabled = state.busy || !input?.value;
  if (!preview?.open) return;
  const result = inspectPrivacy(state.text, { terms: terms(state.maskTerms) });
  root.querySelector('#masked-source').value = result.text;
  root.querySelector('#privacy-count').textContent = privacySummary(result);
}
