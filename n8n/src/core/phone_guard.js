// Find phone-number-like tokens in outgoing text. Every one of them must exist
// in core.number_registry (checked in SQL by core.disallowed_numbers), so the
// bot can never send a number that isn't in the verified data.
const CANDIDATE = /\+?\d[\d \t.-]{4,}\d/g; // spaces/dots/hyphens inside one line only - never across a line break
const COORD = /(?<![\d.])\d{1,3}\.\d{4,}(?![\d.])/g; // lat/lon in map links, e.g. 25.678912,85.123456
// Tokens that look numeric but are never phone numbers
const NOT_PHONE = [
  /^\d{4}-\d{2}-\d{2}$/,                  // 2026-11-24
  /^\d{1,2}[.-]\d{1,2}[.-]\d{2,4}$/,      // 24-11-2026, 24.11.26
  /^\d{4}-\d{2}$/,                        // 2025-26
  /^\d{1,2}\.\d{2}\s*-\s*\d{1,2}\.\d{2}$/, // 18.00-20.00
];
// Zero of each Unicode decimal-digit block an LLM or a sheet might use:
// Arabic-Indic, Extended Arabic-Indic, Devanagari, Bengali, Gurmukhi, Gujarati,
// Oriya, Tamil, Telugu, Kannada, Malayalam, full-width.
const DIGIT_ZEROS = [0x660, 0x6f0, 0x966, 0x9e6, 0xa66, 0xae6, 0xb66, 0xbe6, 0xc66, 0xce6, 0xd66, 0xff10];

// "९८७६५४३२१०" -> "9876543210", so a number can't slip past in another script.
function asciiDigits(text) {
  return String(text || '').replace(/\p{Nd}/gu, (ch) => {
    const cp = ch.codePointAt(0);
    const zero = DIGIT_ZEROS.find((z) => cp >= z && cp <= z + 9);
    return zero === undefined ? ch : String(cp - zero);
  });
}

function extractPhones(text) {
  const found = new Set();
  const scanned = asciiDigits(text).replace(COORD, ' ');
  for (const m of scanned.matchAll(CANDIDATE)) {
    const token = m[0].trim().replace(/[.-]+$/, '');
    if (NOT_PHONE.some((re) => re.test(token))) continue;
    const digits = token.replace(/\D/g, '');
    if (digits.length < 6 || digits.length > 13) continue;
    found.add(digits);
  }
  return Array.from(found);
}

if (typeof module !== 'undefined') module.exports = { extractPhones, asciiDigits };
