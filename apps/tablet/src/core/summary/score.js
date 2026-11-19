import { C, cp, grams, containment, markers } from './normalize.js';

export const words = text => text.toLowerCase().match(/[가-힣]+|[a-z]+|[0-9]+/g) || [];
export function score(sentences, keepTerms = []) {
  const counts = new Map(), postings = new Map(), seen = new Set();
  for (const sentence of sentences) {
    sentence.grams = grams(sentence.text);
    // Conversational acknowledgments, transition promises and offers to do
    // another task are not factual content to spend the summary budget on.
    sentence.excluded = /^(?:맞습니다[.!]?|네[.!]?|단순히 .*이유는 명확합니다[.!]?|왜 .*인가[?？]|.*(?:정리해 드릴까요|도와드릴까요)[?？])$/u.test(sentence.text);
    sentence.duplicate = seen.has(sentence.text);
    if (!sentence.duplicate) {
      const possible = new Map();
      for (const gram of sentence.grams) for (const prior of postings.get(gram) || []) possible.set(prior, (possible.get(prior) || 0) + 1);
      sentence.duplicate = [...possible].some(([prior, common]) => common / Math.max(1, Math.min(sentence.grams.size, prior.grams.size)) >= C.DUP_CONTAINMENT);
    }
    if (sentence.duplicate || sentence.excluded) continue;
    seen.add(sentence.text);
    for (const gram of sentence.grams) { if (!postings.has(gram)) postings.set(gram, []); postings.get(gram).push(sentence); }
    sentence.terms = words(sentence.text);
    for (const word of new Set(sentence.terms)) counts.set(word, (counts.get(word) || 0) + 1);
  }
  const unique = sentences.filter(s => !s.duplicate && !s.excluded), centroid = new Map();
  for (const sentence of unique) {
    const tf = new Map();
    for (const term of sentence.terms) tf.set(term, (tf.get(term) || 0) + 1);
    sentence.vector = [...tf].map(([term, n]) => [term, n * (Math.log((unique.length + 1) / (counts.get(term) + 1)) + 1)]);
    for (const [term, value] of sentence.vector) centroid.set(term, (centroid.get(term) || 0) + value);
  }
  const norm = Math.sqrt([...centroid.values()].reduce((sum, v) => sum + v * v, 0));
  for (const sentence of sentences) {
    if (sentence.duplicate || sentence.excluded) { sentence.score = -1; continue; }
    const dot = sentence.vector.reduce((sum, [term, v]) => sum + v * centroid.get(term), 0);
    const localNorm = Math.sqrt(sentence.vector.reduce((sum, [, v]) => sum + v * v, 0));
    const anchors = (sentence.text.match(/\d+/g) || []).length + markers(sentence.text, [...C.NEGATION, ...C.CONDITION]).length + keepTerms.filter(t => sentence.text.includes(t)).length;
    sentence.score = Number((dot / (localNorm * norm || 1) + 0.3 * anchors / Math.max(1, cp(sentence.text)) + (sentence.first ? 0.2 : 0)).toFixed(12));
  }
}
export function rankGroups(groups) {
  for (const g of groups) {
    const top = g.sentences.filter(s => !s.duplicate && s.score >= 0).map(s => s.score).sort((a, b) => b - a).slice(0, 3);
    g.weight = top.length ? Number((top[0] + 0.5 * top.reduce((a, b) => a + b, 0) / top.length).toFixed(12)) : 0;
  }
  return groups.filter(g => g.weight > 0).sort((a, b) => b.weight - a.weight || a.order - b.order);
}
export function allocate(groups, budget) {
  const k = Math.min(groups.length, Math.floor((budget + 1) / (C.MIN_GROUP_BUDGET + 1)));
  const selected = groups.slice(0, k), available = budget - Math.max(0, k - 1);
  if (!k) return [];
  const total = selected.reduce((sum, g) => sum + g.weight, 0);
  // Reserve the minimum first. This avoids a minimum floor overflowing B.
  const residual = available - k * C.MIN_GROUP_BUDGET;
  const budgets = selected.map(g => ({ group: g, budget: C.MIN_GROUP_BUDGET + Math.floor(residual * g.weight / total) }));
  let remaining = available - budgets.reduce((sum, x) => sum + x.budget, 0);
  for (let i = 0; remaining > 0; i++, remaining--) budgets[i % k].budget++;
  return budgets;
}
