import { C, cp } from './normalize.js';

// Shared with brief.segment: terminal punctuation and EVERY newline.
const boundary = /[.?!。]+["'”’」』)]*(?=\s|$)|\n/g;
const abbreviation = /(?:\b(?:[A-Za-z]\.){2,}|\b(?:Mr|Mrs|Ms|Dr|Prof|Sr|Jr|vs|etc)\.)$/i;
export function splitSentences(text) {
  const result = [];
  let start = 0;
  const append = end => {
    const raw = text.slice(start, end);
    const left = raw.length - raw.trimStart().length;
    const value = raw.trim();
    if (value) result.push({ text: value, start: cp(text.slice(0, start + left)), end: cp(text.slice(0, start + left + value.length)) });
  };
  for (const match of text.matchAll(boundary)) {
    if (match[0].startsWith('.') && abbreviation.test(text.slice(0, match.index + 1))) continue;
    append(match[0] === '\n' ? match.index : match.index + match[0].length);
    start = match.index + match[0].length;
  }
  append(text.length);
  return result;
}
export function segment(text) {
  const lines = text.split('\n');
  const result = [];
  let offset = 0, title = '', section = 0, first = true;
  for (let i = 0; i < lines.length; i++) {
    const raw = lines[i], trimmed = raw.trim();
    const heading = /^#{1,6}\s+/u.test(trimmed) || (trimmed && cp(trimmed) <= C.HEADING_MAX_CP && !/[.?!。]$/u.test(trimmed) && lines[i + 1] === '' && !/^[-*•]|^\d+[.)]\s/u.test(trimmed));
    if (heading) { title = trimmed.replace(/^#{1,6}\s+/u, ''); section++; first = true; }
    else {
      const prefix = raw.match(/^\s*(?:[-*•]\s+|\d+[.)]\s+)/u)?.[0] || '';
      for (const part of splitSentences(raw.slice(prefix.length))) {
        const start = offset + cp(prefix) + part.start;
        result.push({ id: `s${result.length + 1}`, text: part.text, span: [start, offset + cp(prefix) + part.end], title, section, first, order: result.length });
        first = false;
      }
    }
    offset += cp(raw) + 1;
  }
  return result;
}
