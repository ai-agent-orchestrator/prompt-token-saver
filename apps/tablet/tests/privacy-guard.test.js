import test from 'node:test';
import assert from 'node:assert/strict';
import { maskPersonalData, MASKING_VERSION } from '../src/core/privacy-guard.js';
import { inspectPrivacy, maskOutbound } from '../src/core/masking.js';
import { privacyMarkup } from '../src/core/privacy-panel.js';
import { boardMarkup } from '../src/core/summary/board.js';
import { summarize } from '../src/core/summary/engine.js';

// Synthetic cases from the user's source module's test_policy_actions.py.
for (const [source, expected] of [
  ['연락처 010-0000-0000', '연락처 [PHONE]'],
  ['전화 01000000000 / 02 000 0000', '전화 [PHONE] / [PHONE]'],
  ['+82 10 0000 0000', '[PHONE]'],
  ['sample+test@example.invalid', '[EMAIL]'],
  ['메일sample@example.invalid로', '메일[EMAIL]로'],
  ['① 사건 원문\n  전화 010-0000-0000', '① 사건 원문\n  전화 [PHONE]'],
  ['900101-1234567', '[ID_NUMBER]'],
  ['9001011234567', '[ID_NUMBER]'],
  ['０１０－００００－００００', '[PHONE]'],
  ['010-0000-\u200b0000', '[PHONE]'],
  ['[PHONE] [EMAIL] [ID_NUMBER]', '[PHONE] [EMAIL] [ID_NUMBER]'],
  ['사건번호 2026가단12345 / 123456789012345', '사건번호 2026가단12345 / 123456789012345'],
  ['① 자료 ０１０－００００－００００ / ② 계약서', '① 자료 [PHONE] / ② 계약서'],
  ['다음\u200b자료는 그대로', '다음\u200b자료는 그대로'],
  ['😀 ０７０－００００－００００ 900101-5123456', '😀 [PHONE] [ID_NUMBER]'],
]) test(`privacy source-port: ${JSON.stringify(source)}`, () => {
  const result = maskPersonalData(source);
  assert.equal(result.text, expected);
  assert.equal(maskPersonalData(result.text).text, expected);
  assert.equal(result.version, MASKING_VERSION);
  assert.ok(!('original' in result) && !('spans' in result) && !('dictionary' in result));
});

test('outbound masking keeps financial/date behavior while adding normalized detection', () => {
  const source = '① 거래 2026-11-19 / 계좌번호: １２３４５６７８９０ / ０１０－００００－００００ / a@example.invalid';
  const result = inspectPrivacy(source);
  assert.ok(result.text.includes('① 거래 2026-11-19'));
  assert.ok(result.text.includes('[계좌번호]') && result.text.includes('[전화번호]') && result.text.includes('[이메일]'));
  assert.equal(result.redactions, 3);
  assert.equal(result.reasonCode, 'PERSONAL_DATA_MASKED');
  assert.deepEqual(result.matchedRules, ['ACCOUNT', 'EMAIL', 'PHONE']);
  assert.deepEqual(Object.keys(maskOutbound(source)).sort(), ['redactions', 'text']);
});

test('custom literal terms win overlapping matches and preserve surrounding original characters', () => {
  const result = inspectPrivacy('① 홍길동연구소의 홍길동이 😀 a+b와 010-0000-0000를 기록함.', { terms: ['홍길동', '홍길동연구소', 'a+b', '010-0000-0000'] });
  assert.equal(result.redactions, 4);
  assert.ok(result.text.startsWith('① [비공개'));
  assert.ok(result.text.includes('의 ') && result.text.includes('이 😀 ') && result.text.includes('를 기록함.'));
  assert.equal(inspectPrivacy(result.text).redactions, 0);
});

test('privacy UI contains only the switch, short help and extra terms input', () => {
  const html = privacyMarkup({ maskTerms: '<script>', busy: false, privacyEnabled: true });
  assert.ok(html.includes('개인정보 보호기능 켜기') && html.includes('주민번호/전화번호/이메일'));
  assert.ok(html.includes('추가로 가릴 이름·기관·주소'));
  assert.ok(!html.includes('<script>') && html.includes('&lt;script&gt;'));
  assert.ok(!html.includes('<button') && !html.includes('<details') && !html.includes('<textarea'));
  assert.ok(!html.includes('자동 가리기') && !html.includes('마스킹 버전'));
  assert.ok(privacyMarkup({ maskTerms: '', busy: false, privacyEnabled: false }).includes('placeholder="쉼표로 구분해 입력" disabled'));
});

test('the decision board masks candidate text without mutating verification evidence', async () => {
  const source = '자료 검토 담당자의 연락처는 010-0000-0000입니다. '.repeat(10);
  const run = await summarize(source);
  assert.ok(run.report.groups.some(g => g.attempts.length > 0));
  const before = JSON.stringify(run);
  const html = boardMarkup(run, {}, value => maskOutbound(value).text);
  assert.ok(!html.includes('010-0000-0000') && html.includes('[전화번호]'));
  assert.equal(JSON.stringify(run), before);
});


test('partial dictionary matches cannot expose the remainder of a detected identifier', () => {
  const result = inspectPrivacy('sample@example.invalid 010-0000-0000', { terms: ['sample', '010'] });
  assert.equal(result.redactions, 2);
  assert.ok(!result.text.includes('example.invalid') && !result.text.includes('0000-0000'));
});

import { outboundSummary } from '../src/core/summary/output.js';
test('privacy switch governs the actual outbound body', () => {
  const run = { status: 'OK', body: '010-0000-0000 홍길동', metrics: { budget: 300 } };
  assert.equal(outboundSummary(run, ['홍길동'], false).text, run.body);
  assert.ok(!outboundSummary(run, ['홍길동'], true).text.includes('010-0000-0000'));
  assert.ok(!outboundSummary(run, ['홍길동'], true).text.includes('홍길동'));
});
