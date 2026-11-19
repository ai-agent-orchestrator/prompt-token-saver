import test from 'node:test';
import assert from 'node:assert/strict';
import { maskOutbound } from '../src/core/masking.js';

test('longest literal dictionary terms preserve punctuation and Korean particles', () => {
  const result = maskOutbound('홍길동연구소의 홍길동이 a+b를 썼다.', { terms: ['홍길동', '홍길동연구소', 'a+b'] });
  assert.equal(result.redactions, 3);
  assert.doesNotMatch(result.text, /홍길동|a\+b/u);
  assert.match(result.text, /의 .*이/u);
  assert.deepEqual(Object.keys(result).sort(), ['redactions', 'text']);
});

test('outbound patterns mask synthetic identifiers but keep dates and scientific values', () => {
  const input = '가짜 test@example.invalid, 010-1234-5678, 900101-1234567, 123-456789-01234. 날짜 2026-11-18, 농도 3.5%, 10~20 mg.';
  const result = maskOutbound(input);
  for (const sensitive of ['test@example.invalid', '010-1234-5678', '900101-1234567', '123-456789-01234']) {
    assert.ok(!result.text.includes(sensitive));
  }
  assert.ok(result.redactions >= 4);
  assert.match(result.text, /2026-11-18/u);
  assert.match(result.text, /3\.5%/u);
  assert.match(result.text, /10~20 mg/u);
});

test('masking does not mutate caller dictionary or require storage', () => {
  const terms = Object.freeze(['합성 이름']);
  assert.equal(maskOutbound('합성 이름 합성 이름', { terms }).redactions, 2);
  assert.equal(maskOutbound('그냥 공개 문장').redactions, 0);
  assert.doesNotMatch(maskOutbound('계좌번호: 1234567890').text, /1234567890/u);
});
