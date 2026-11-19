import { C, cp, grams, containment, markers } from './normalize.js';
import { splitSentences } from './segment.js';

export const polluted = text => /^\s*(?:#|[-*•]\s|\d+[.)]\s)|상태:|근거:|조사 요청|코드포인트\s*\[|[{}]|\[\d+,\s*\d+\)/mu.test(text);
const numberPattern = /[$€£¥₩]?[+-]?(?:[0-9]+(?:,[0-9]{3})*(?:\.[0-9]+)?|\.[0-9]+)(?:\s*%|[a-zA-Z]+|[가-힣]+)?/g;
export const stripJosa = value => {
  if (!/^[가-힣]+$/u.test(value)) return value;
  for (const suffix of ['에서', '으로', '은', '는', '이', '가', '을', '를', '의', '에', '로', '와', '과', '도', '만']) if (value.endsWith(suffix) && cp(value) - cp(suffix) >= 2) return value.slice(0, -suffix.length);
  return value;
};
export function numbers(text) {
  return [...text.matchAll(numberPattern)].map(m => {
    const value = m[0].toLowerCase().replace(/[,\s]/g, '');
    const parts = value.match(/^([$€£¥₩]?)([+-]?(?:\d+(?:\.\d+)?|\.\d+))(.*)$/u);
    let numeric = parts[2].replace(/^\+/, '');
    numeric = numeric.replace(/^(-?)0+(?=\d)/, '$1').replace(/(\.\d*?)0+$/, '$1').replace(/\.$/, '');
    if (/^-?0(?:\.0*)?$/u.test(numeric)) numeric = '0';
    return { text: m[0], norm: parts[1] + numeric + stripJosa(parts[3]), start: m.index, end: m.index + m[0].length };
  });
}
export function matchSentences(candidate, group) {
  return splitSentences(candidate).map(part => {
    const query = grams(part.text);
    let source = null, score = -1;
    for (const sentence of group.sentences) {
      const value = containment(query, sentence.grams || grams(sentence.text));
      if (value > score) { source = sentence; score = value; }
    }
    return { text: part.text, source, score };
  });
}
export function checkMeaning(candidate, group, method, thresholds = {}) {
  if (!candidate.trim()) return { result: 'FAIL', reason: 'EMPTY', matches: [] };
  if (polluted(candidate)) return { result: 'FAIL', reason: 'BODY_FORMAT', matches: [] };
  const matches = matchSentences(candidate, group);
  const threshold = thresholds[method] ?? (method === 'model' ? C.TAU_A_MODEL : C.TAU_A_EXTRACT);
  let reason = null;
  for (const match of matches) {
    if (!match.source) { reason = 'NO_SOURCE'; break; }
    if (JSON.stringify(markers(match.text, C.NEGATION)) !== JSON.stringify(markers(match.source.text, C.NEGATION))) { reason = 'NEGATION_CHANGED'; break; }
    if (markers(match.source.text, C.CONDITION).some(m => !markers(match.text, C.CONDITION).includes(m))) { reason = 'CONDITION_DROPPED'; break; }
    if (match.score < threshold) { reason = 'LOW_CONTAINMENT'; break; }
  }
  return { result: reason ? 'FAIL' : 'PASS', reason, threshold, matches: matches.map(m => ({ sentenceId: m.source?.id, text: m.text, score: m.score, span: m.source?.span })) };
}
export function checkAnchors(candidate, group, keepTerms = []) {
  const matched = matchSentences(candidate, group), records = [];
  let reason = candidate.trim() ? null : 'EMPTY';
  for (const match of matched) {
    if (!match.source) { reason ||= 'NO_SOURCE'; continue; }
    const source = match.source.text, original = numbers(source), selected = numbers(match.text);
    const norms = new Set(selected.map(n => n.norm));
    for (const number of selected) {
      const sourceNumber = original.find(n => n.norm === number.norm);
      records.push({ text: number.text, sourceSentence: match.source.id });
      if (!sourceNumber) { reason ||= 'NUMBER_NOT_IN_SOURCE'; continue; }
      const boundaries = [...source.matchAll(/,|며|고/gu)].map(m => m.index);
      const left = Math.max(-1, ...boundaries.filter(i => i < sourceNumber.start));
      const right = boundaries.find(i => i > sourceNumber.end) ?? source.length;
      if (original.some(n => n.start > left && n.start < right && !norms.has(n.norm))) reason ||= 'NUMBER_RELATION_BROKEN';
      // Keep two preceding content words, so replacing the subject while
      // retaining a generic noun such as '오차' cannot pass unnoticed.
      const before = source.slice(left + 1, sourceNumber.start).match(/[A-Za-z_]+|[가-힣]+/gu) || [];
      const candidateWords = new Set((match.text.match(/[A-Za-z_]+|[가-힣]+/gu) || []).map(w => stripJosa(w).toLowerCase()));
      if (before.slice(-2).some(w => !candidateWords.has(stripJosa(w).toLowerCase()))) reason ||= 'SUBJECT_DETACHED';
    }
    // Capitalized source identifiers are anchored too; Korean proper-name
    // recognition is unavailable and is never claimed by this rule checker.
    const sourceNames = new Set(source.match(/\b[A-Z][A-Za-z_0-9]+\b/g) || []);
    if ((match.text.match(/\b[A-Z][A-Za-z_0-9]+\b/g) || []).some(n => !sourceNames.has(n))) reason ||= 'NAME_NOT_IN_SOURCE';
  }
  for (const term of keepTerms) if (group.sentences.some(s => s.text.includes(term)) && !candidate.includes(term)) reason ||= 'KEEP_TERM_DROPPED';
  return { result: reason ? 'FAIL' : 'PASS', reason, numbers: records };
}
export const checkLength = (candidate, limit) => ({ result: cp(candidate) <= limit ? 'PASS' : 'FAIL', reason: cp(candidate) <= limit ? null : 'OVER_BUDGET', cp: cp(candidate), limit });
export async function checks(candidate, group, method, budget, keepTerms = [], thresholds = {}) {
  const [meaning, anchor, length] = await Promise.all([
    Promise.resolve().then(() => checkMeaning(candidate, group, method, thresholds)),
    Promise.resolve().then(() => checkAnchors(candidate, group, keepTerms)),
    Promise.resolve().then(() => checkLength(candidate, budget)),
  ]);
  return { meaning, anchor, length };
}
export const accepted = checks => Object.values(checks).every(check => check.result === 'PASS');
