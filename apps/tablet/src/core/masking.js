// This boundary returns an outbound copy only. Dictionaries and reverse mappings
// are never written to storage or included in the returned value.
export function maskOutbound(value, { terms = [] } = {}) {
  let text = String(value ?? '');
  let redactions = 0;
  const dictionary = [...new Set(terms.map(term => String(term).trim()).filter(Boolean))]
    .sort((a, b) => [...b].length - [...a].length || a.localeCompare(b));
  if (dictionary.length) {
    const aliases = new Map(dictionary.map((term, index) => [term, `[비공개${index + 1}]`]));
    const literal = term => term.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    text = text.replace(new RegExp(dictionary.map(literal).join('|'), 'gu'), match => {
      redactions += 1;
      return aliases.get(match);
    });
  }
  const replace = (pattern, label, accept = () => true) => {
    text = text.replace(pattern, match => {
      if (!accept(match)) return match;
      redactions += 1;
      return `[${label}]`;
    });
  };
  replace(/[\p{L}\p{N}._%+-]+@[\p{L}\p{N}.-]+\.[\p{L}]{2,}/giu, '이메일');
  replace(/(?<!\d)\d{6}[- ]?[1-4]\d{6}(?!\d)/gu, '식별번호');
  replace(/(?<!\d)(?:\+82[- .]?(?:0)?|0)(?:1[016789]|2|[3-6]\d)[- .]?\d{3,4}[- .]?\d{4}(?!\d)/gu, '전화번호');
  replace(/(?:계좌(?:\s*번호)?|account(?:\s*number)?)\s*(?:는|은)?\s*[:：]?\s*\d(?:[ -]?\d){8,19}(?!\d)/giu, '계좌번호');
  replace(/(?<!\d)(?:\d[ -]?){13,19}(?!\d)/gu, '카드·계좌번호', match => {
    const count = match.replace(/\D/g, '').length;
    return count >= 13 && count <= 19;
  });
  replace(/(?<!\d)\d{2,6}(?:-\d{2,8}){1,4}(?!\d)/gu, '계좌번호', match => {
    // A date is an anchor, not a bank account.
    if (/^\d{4}-\d{1,2}-\d{1,2}$/.test(match)) return false;
    return match.replace(/\D/g, '').length >= 10;
  });
  return { text, redactions };
}
