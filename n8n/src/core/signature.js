// Meta webhook signature check (X-Hub-Signature-256 = "sha256=" + HMAC-SHA256(rawBody, APP_SECRET)).
// `crypto` is passed in so this module stays pure and testable outside n8n.
function verifySignature(rawBody, header, appSecret, crypto) {
  if (!appSecret || typeof header !== 'string' || !header.startsWith('sha256=')) return false;
  const body = Buffer.isBuffer(rawBody) ? rawBody : Buffer.from(String(rawBody ?? ''), 'utf8');
  const expected = crypto.createHmac('sha256', appSecret).update(body).digest();
  let given;
  try {
    given = Buffer.from(header.slice(7), 'hex');
  } catch (e) {
    return false;
  }
  return given.length === expected.length && crypto.timingSafeEqual(given, expected);
}

if (typeof module !== 'undefined') module.exports = { verifySignature };
