import { C, cp, grams } from './normalize.js';
export function group(sentences) {
  const groups = [];
  let current, previous;
  for (const sentence of sentences) {
    const next = grams(sentence.text, 2);
    let intersection = 0;
    if (previous) for (const value of next) if (previous.has(value)) intersection++;
    const similarity = previous ? intersection / Math.max(1, next.size + previous.size - intersection) : 0;
    if (!current || sentence.section !== current.section || current.size + cp(sentence.text) + 1 > C.MAX_GROUP_CP || current.sentences.length >= C.MAX_GROUP_SENT || (!sentence.title && similarity < C.GROUP_SIM)) {
      current = { id: `g${groups.length + 1}`, title: sentence.title || `주제 ${groups.length + 1}`, section: sentence.section, sentences: [], size: 0, order: sentence.order };
      groups.push(current);
    }
    current.sentences.push(sentence); current.size += cp(sentence.text) + (current.sentences.length > 1 ? 1 : 0);
    previous = next;
  }
  return groups;
}
