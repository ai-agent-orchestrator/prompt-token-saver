const esc = value => String(value ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);
export function privacyMarkup(state) {
  return `<section class="privacy-panel" aria-label="개인정보 보호">
    <label class="privacy-switch" for="privacy-enabled"><input id="privacy-enabled" type="checkbox" ${state.privacyEnabled ? 'checked' : ''} ${state.busy ? 'disabled' : ''}/><span>개인정보 보호기능 켜기</span></label>
    <p class="privacy-description">개인정보(주민번호/전화번호/이메일)를 보호해 드려요.</p>
    <div class="privacy-terms"><label for="mask-terms">추가로 가릴 이름·기관·주소</label><input id="mask-terms" value="${esc(state.maskTerms)}" placeholder="쉼표로 구분해 입력" ${state.busy || !state.privacyEnabled ? 'disabled' : ''}/></div>
  </section>`;
}
