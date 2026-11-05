// Strips credentials from any text before it is logged or returned.

const PATTERNS = [
  // OpenAI-style keys. The lookbehind stops words such as "Risk-based" matching.
  [/(?<![A-Za-z0-9])sk-[A-Za-z0-9_-]{16,}/g, '[redacted-key]'],
  [/(\bapi_key=)[^&\s"']+/gi, '$1[redacted]'],
  [/(\bBearer\s+)[A-Za-z0-9._~+/=-]{8,}/gi, '$1[redacted]'],
  [/(\bnsai_sid=)[A-Za-z0-9]+/g, '$1[redacted]'],
  [/(?<![A-Za-z0-9])[a-f0-9]{64}(?![A-Za-z0-9])/g, '[redacted-key]'],
];

/** `secrets` may list exact values (for example the keys of the current session). */
export function redact(text, secrets = []) {
  let out = String(text ?? '');
  for (const s of secrets) {
    if (typeof s === 'string' && s.length >= 6) out = out.split(s).join('[redacted]');
  }
  for (const [re, rep] of PATTERNS) out = out.replace(re, rep);
  return out;
}
