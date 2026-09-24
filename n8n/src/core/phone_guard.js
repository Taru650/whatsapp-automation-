// Find phone-number-like tokens in outgoing text. Every one of them must exist
// in core.number_registry (checked in SQL by core.disallowed_numbers), so the
// bot can never send a number that isn't in the verified data.
const CANDIDATE = /\+?\d[\d \t-]{4,}\d/g; // spaces/hyphens inside one line only - never across a line break
const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/;
const DECIMAL = /\d+\.\d+/g; // coordinates/distances in map links, e.g. 25.678912,85.123456

function extractPhones(text) {
  const found = new Set();
  const scanned = String(text || '').replace(DECIMAL, ' ');
  for (const m of scanned.matchAll(CANDIDATE)) {
    const token = m[0].trim();
    if (ISO_DATE.test(token)) continue;
    const digits = token.replace(/\D/g, '');
    if (digits.length < 6 || digits.length > 13) continue;
    found.add(digits);
  }
  return Array.from(found);
}

if (typeof module !== 'undefined') module.exports = { extractPhones };
