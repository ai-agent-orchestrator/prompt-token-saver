import { C, cp, markers } from './normalize.js';
export function compress(text, keepTerms = []) {
  let value = text.replace(/^\s*(?:#{1,6}\s+|[-*•]\s+|\d+[.)]\s+)/u, '').replace(/\[([^\]]+)\]\([^)]*\)/gu, '$1').replace(/\*\*|__|`/gu, '');
  // R2 must not remove a protected name, negation or condition either.
  value = value.replace(/\([^()]*\)|\[[^\[\]]*\]/gu, part => /\d/u.test(part) || markers(part, [...C.NEGATION, ...C.CONDITION, ...keepTerms]).length ? part : '');
  value = value.replace(/\s+/gu, ' ').trim().replace(/^(?:또한, |그리고 |참고로 |한편 |기본적으로 )/u, '');
  const endings = [['했습니다.', '했음.'], ['있습니다.', '있음.'], ['없습니다.', '없음.'], ['합니다.', '함.'], ['입니다.', '임.'], ['됩니다.', '됨.'], ['한다.', '함.'], ['이다.', '임.'], ['된다.', '됨.'], ['있다.', '있음.'], ['없다.', '없음.']];
  for (const [from, to] of endings) if (value.endsWith(from)) return value.slice(0, -from.length) + to;
  return value;
}
export function extract(group, budget, keepTerms = [], candidates = group.sentences) {
  const selected = [];
  let used = 0;
  for (const sentence of candidates.filter(s => !s.duplicate && s.score >= 0).sort((a, b) => b.score - a.score || a.order - b.order)) {
    const text = compress(sentence.text, keepTerms), cost = cp(text) + (selected.length ? 1 : 0);
    if (text && used + cost <= budget) { selected.push({ sentence, text }); used += cost; }
  }
  return selected.sort((a, b) => a.sentence.order - b.sentence.order).map(s => s.text).join(' ');
}
