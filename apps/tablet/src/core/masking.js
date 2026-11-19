import { maskPersonalData, OUTPUT_LABELS } from './privacy-guard.js';

// Existing outbound contract contains no dictionaries or reverse mappings.
export function inspectPrivacy(value, { terms = [] } = {}) {
  return maskPersonalData(value, { terms, financial: true, labels: OUTPUT_LABELS });
}
export function maskOutbound(value, options = {}) {
  const { text, redactions } = inspectPrivacy(value, options);
  return { text, redactions };
}
