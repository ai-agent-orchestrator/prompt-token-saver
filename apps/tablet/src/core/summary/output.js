import { maskOutbound } from '../masking.js';
import { cp } from './normalize.js';
// One output contract for the textarea, clipboard and Drive summary file.
export function outboundSummary(run, maskTerms = []) {
  const text = run?.status === 'OK' ? maskOutbound(run.body, { terms: maskTerms }).text : '';
  return { key: 'summary', text, codepoints: cp(text), overBudget: cp(text) > (run?.metrics?.budget ?? 0) };
}
