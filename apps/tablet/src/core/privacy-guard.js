// Browser port of the user's ai-security-architecture Privacy Output Guard.
// Source: feat/python-security-actions @ 00dfd55e4b25161a3d23680c5a896bd7808a1487
// python-security-actions/app/security/policy_core.py: mask_personal_data.
// Detection uses NFKC/Cf normalization; replacements touch ORIGINAL spans only.
export const MASKING_VERSION = 'legal-pii-2026-11-09-v1-browser-1';
export const OUTPUT_LABELS = Object.freeze({ ID_NUMBER: '식별번호', EMAIL: '이메일', PHONE: '전화번호', ACCOUNT: '계좌번호', FINANCIAL: '카드·계좌번호' });
const RULES = [
  ['ID_NUMBER', /(?<!\d)\d{6}[-\s]?[1-8]\d{6}(?!\d)/gu],
  // Bounded labels avoid unbounded backtracking with the app's 500k inputs.
  ['EMAIL', /(?<![a-z0-9.+-])[a-z0-9.!#$%&'*+/=?^_`{|}~-]{1,64}@[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?(?:\.[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?){1,20}/giu],
  ['PHONE', /(?<!\d)(?:\+82[- .]?(?:0?10|0?2|0?[3-6][1-5]|0?70)|0(?:10|11|16|17|18|19|2|[3-6][1-5]|70))[- .]?\d{3,4}[- .]?\d{4}(?!\d)/gu],
];
const FINANCIAL_RULES = [
  ['ACCOUNT', /(?:계좌(?:\s*번호)?|account(?:\s*number)?)\s*(?:는|은)?\s*[:：]?\s*\d(?:[ -]?\d){8,19}(?!\d)/giu],
  ['FINANCIAL', /(?<!\d)(?:\d[ -]?){13,19}(?!\d)/gu],
  ['ACCOUNT', /(?<!\d)\d{2,6}(?:-\d{2,8}){1,4}(?!\d)/gu],
];
function detectionView(text) {
  const view = [], starts = [], ends = [];
  let offset = 0;
  for (const original of text) {
    for (const char of original.normalize('NFKC')) {
      if (/\p{Cf}/u.test(char)) continue;
      view.push(char);
      for (let i = 0; i < char.length; i++) { starts.push(offset); ends.push(offset + original.length); }
    }
    offset += original.length;
  }
  return { text: view.join(''), starts, ends };
}
export function maskPersonalData(value, { terms = [], financial = false, labels = {} } = {}) {
  const text = String(value ?? '');
  const view = detectionView(text), spans = [], counts = {};
  const add = (start, end, rule, replacement) => {
    spans.push({ start, end, replacement, rule });
  };
  const dictionary = [...new Set(terms.map(term => String(term).trim()).filter(Boolean))].sort((a, b) => [...b].length - [...a].length || a.localeCompare(b));
  if (dictionary.length) {
    const literal = term => term.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    const aliases = new Map(dictionary.map((term, index) => [term, `[비공개${index + 1}]`]));
    for (const match of text.matchAll(new RegExp(dictionary.map(literal).join('|'), 'gu'))) add(match.index, match.index + match[0].length, 'CUSTOM', aliases.get(match[0]));
  }
  for (const [rule, regex] of [...RULES, ...(financial ? FINANCIAL_RULES : [])]) {
    if (rule === 'EMAIL' && !view.text.includes('@')) continue;
    for (const match of view.text.matchAll(regex)) {
      if (rule === 'ACCOUNT' && /^\d{4}-\d{1,2}-\d{1,2}$/u.test(match[0])) continue;
      const digits = match[0].replace(/\D/g, '').length;
      if (rule === 'FINANCIAL' && (digits < 13 || digits > 19)) continue;
      if (rule === 'ACCOUNT' && !/계좌|account/iu.test(match[0]) && digits < 10) continue;
      add(view.starts[match.index], view.ends[match.index + match[0].length - 1], rule, `[${labels[rule] || rule}]`);
    }
  }
  // Partial dictionary matches must not expose the rest of an identifier.
  spans.sort((a, b) => a.start - b.start || b.end - a.end);
  const merged = [];
  for (const span of spans) {
    const previous = merged.at(-1);
    if (previous && span.start < previous.end) {
      if (span.end - span.start > previous.selectedLength) { previous.replacement = span.replacement; previous.rule = span.rule; previous.selectedLength = span.end - span.start; }
      previous.end = Math.max(previous.end, span.end);
    } else merged.push({ ...span, selectedLength: span.end - span.start });
  }
  const output = []; let cursor = 0;
  for (const span of merged) counts[span.rule] = (counts[span.rule] || 0) + 1;
  for (const span of merged) { output.push(text.slice(cursor, span.start), span.replacement); cursor = span.end; }
  output.push(text.slice(cursor));
  return { text: output.join(''), redactions: merged.length, matchedRules: Object.keys(counts).sort(), counts,
    decision: merged.length ? 'TRANSFORM' : 'ALLOW', reasonCode: merged.length ? 'PERSONAL_DATA_MASKED' : 'SAFE', version: MASKING_VERSION };
}
