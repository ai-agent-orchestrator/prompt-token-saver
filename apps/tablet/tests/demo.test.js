import test from 'node:test';
import assert from 'node:assert/strict';
import { syntheticResearch } from '../src/demo.js';
import { analyzeResearch, buildArtifacts } from '../src/core/research.js';

test('the public demo contains about 35 reference pages of synthetic source material', () => {
  const sample = syntheticResearch();
  const length = [...sample.text].length;
  assert.ok(length >= 45_000 && length <= 60_000, `Expected 30–40 reference pages, received ${length} codepoints.`);
  assert.match(sample.text, /실제 개인정보나 실측 결과를 포함하지 않는 합성 예제/);
});

test('the demo yields usable integrated research with late conditions preserved', async () => {
  const sample = syntheticResearch();
  const run = await analyzeResearch({ ...sample, targetContexts: 10 });
  const summary = buildArtifacts(run).find(item => item.key === 'summary');
  assert.ok(run.cards.length >= 8 && run.cards.length <= 12);
  assert.equal(run.status, 'EXTRACTIVE');
  assert.ok(run.cards.every(card => card.status === 'EXTRACTIVE'));
  assert.equal(run.generatorUsed, false);
  assert.equal(run.coverage.processed, run.coverage.total);
  assert.equal(run.coverage.failed, 0);
  assert.equal(run.coverage.criticalKept, run.coverage.criticalTotal);
  assert.ok(summary.pageEquivalent >= 5 && summary.pageEquivalent <= 10);
  assert.notEqual(summary.status, 'PARTIAL');
  assert.match(summary.text, /최종 예외: 분관 운영 중단일은 이용 건수 비교에서 제외하되, 중단 사유는 기록한다\./);
  // Every selected statement is an exact original quote, including the last
  // occurrence of repeated late evidence; fake LLM output is unnecessary.
  const facts = new Map(run.facts.map(fact => [fact.id, fact]));
  for (const card of run.cards) {
    for (const id of card.factIds) {
      const fact = facts.get(id);
      assert.ok(sample.text.includes(fact.text));
      assert.ok(fact.sourceRefs.some(ref => [...sample.text].slice(...ref.span).join('') === fact.text));
    }
  }
  assert.equal(run.metrics.tokens, null);
});
