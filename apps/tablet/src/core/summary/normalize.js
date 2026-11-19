import constants from '../../../../../spec/constants.json' with { type: 'json' };
export const C = Object.freeze(constants);
export const cp = text => [...String(text)].length;
export const normalize = text => String(text).replace(/\r\n?/g, '\n');
export const budgetFor = text => Math.floor(cp(text) / C.BUDGET_DIV);
export async function sourceHash(text) {
  const bytes = await globalThis.crypto.subtle.digest('SHA-256', new TextEncoder().encode(text));
  return [...new Uint8Array(bytes)].map(b => b.toString(16).padStart(2, '0')).join('');
}
export const grams = (text, n = 3) => {
  const chars = [...text.toLowerCase().replace(/\s+/gu, ' ').trim()];
  if (chars.length < n) return new Set(chars.length ? [chars.join('')] : []);
  return new Set(Array.from({ length: chars.length - n + 1 }, (_, i) => chars.slice(i, i + n).join('')));
};
export function containment(a, b) {
  if (!a.size) return 0;
  let common = 0;
  for (const value of a) if (b.has(value)) common++;
  return common / a.size;
}
export const markers = (text, list) => list.filter(value => text.toLowerCase().includes(value));
