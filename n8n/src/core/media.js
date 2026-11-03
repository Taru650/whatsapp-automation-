// Media download for citizen-submitted complaint evidence (images/PDFs).
// Not wired into core-00-router or any shared module list: only the
// svc-complaint workflow requires this, so the router pipeline is untouched.
//
// Stays network-only and pure (no fs/crypto) so it is unit-testable with a
// mocked http, same convention as signature.js ("crypto is passed in..."):
// the caller (services.mjs's complaint() workflow Code node) does the
// hashing and file-writing itself with require('fs')/require('crypto').
//
// `http` = this.helpers.httpRequest (bound); `cfg` = { base, version, token }.
const ALLOWED_MIME = { 'image/jpeg': 'photo', 'image/png': 'photo', 'application/pdf': 'pdf' };
const MAX_BYTES = 10 * 1024 * 1024; // 10 MB

function mimeKind(mime) {
  return ALLOWED_MIME[mime] || null;
}

// Graph API: GET /{media-id} -> { url, mime_type, file_size, ... } (the url is
// short-lived and itself needs the same bearer token to fetch).
async function fetchMediaMeta(mediaId, cfg, http) {
  const url = `${cfg.base || 'https://graph.facebook.com'}/${cfg.version || 'v23.0'}/${mediaId}`;
  return http({ method: 'GET', url, json: true, timeout: 10000, headers: { Authorization: `Bearer ${cfg.token}` } });
}

// Validates mime/size twice (declared by the webhook payload, then confirmed
// by Graph's own media metadata) before ever downloading bytes.
async function downloadMedia(mediaId, declaredMime, cfg, http) {
  if (!mimeKind(declaredMime)) return { error: 'unsupported_mime' };
  let meta;
  try {
    meta = await fetchMediaMeta(mediaId, cfg, http);
  } catch (e) {
    return { error: 'media_lookup_failed' };
  }
  if (!meta || !meta.url) return { error: 'media_lookup_failed' };
  const kind = mimeKind(meta.mime_type || declaredMime);
  if (!kind) return { error: 'unsupported_mime' };
  if (meta.file_size && Number(meta.file_size) > MAX_BYTES) return { error: 'too_large' };
  let res;
  try {
    // 'arraybuffer' is n8n's binary option (IHttpRequestOptions.encoding); the old
    // request-library `encoding: null` makes n8n decode the photo as UTF-8 text,
    // turning every non-ASCII byte into U+FFFD - a corrupted image.
    res = await http({ method: 'GET', url: meta.url, timeout: 20000, encoding: 'arraybuffer',
      returnFullResponse: true, headers: { Authorization: `Bearer ${cfg.token}` } });
  } catch (e) {
    return { error: 'download_failed' };
  }
  const body = res && res.body;
  // a text body means the bytes were already decoded (and damaged): refuse rather than store it
  if (!body || typeof body === 'string') return { error: 'download_failed' };
  const buffer = Buffer.isBuffer(body) ? body : Buffer.from(body);
  if (buffer.length === 0) return { error: 'download_failed' };
  if (buffer.length > MAX_BYTES) return { error: 'too_large' };
  return { buffer, mime: meta.mime_type || declaredMime, kind };
}

if (typeof module !== 'undefined') module.exports = { fetchMediaMeta, downloadMedia, mimeKind, ALLOWED_MIME, MAX_BYTES };
