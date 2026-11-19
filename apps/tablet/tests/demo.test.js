import test from 'node:test';
import assert from 'node:assert/strict';
import { syntheticResearch } from '../src/demo.js';
import { summarize, refine } from '../src/core/summary/engine.js';

test('the public demo contains 30–40 reference pages of synthetic source material', () => {
  const sample = syntheticResearch();
  assert.ok([...sample.text].length >= 45000 && [...sample.text].length <= 60000);
  assert.match(sample.text, /실제 개인정보나 실측 결과를 포함하지 않는 합성 예제/);
});

test('the current demo produces only budgeted bodies and reports omitted evidence', async () => {
  const { text } = syntheticResearch();
  const first = await summarize(text);
  const second = await refine(first, { text });
  assert.equal(first.status, 'OK'); assert.equal(second.status, 'OK');
  assert.ok([...first.body].length <= 300 && [...second.body].length < [...first.body].length);
  assert.ok(first.report.omittedGroups.length > 0 && first.report.omittedAnchors.length > 0);
  assert.equal(first.metrics.tokens, null);
});
