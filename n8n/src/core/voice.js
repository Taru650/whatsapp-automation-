// Voice notes -> text, so a spoken question ("पुलिस स्टेशन कहाँ है") takes exactly
// the same path as a typed one. Used only by the router's "Verify & Explode"
// step, and only while VOICE_ENABLED=true.
//
// Speech-to-text, STT_PROVIDER:
//   sarvam (default): Sarvam AI (Indian; Hindi/English and mixed speech). The
//     audio is a multipart upload, so the router sends it with n8n's own HTTP
//     Request node (a Code node cannot upload bytes); sarvamResult() reads the reply.
//   google: Google Cloud Speech-to-Text v1, JSON body, sent from the Code node
//     with the sheet's service account (transcribeVoice()).
//
// Pure helpers (no fs, crypto passed in) so they are unit-testable; the caller
// passes `http` = this.helpers.httpRequest.

const MAX_AUDIO_BYTES = 1024 * 1024;      // ~5 min of WhatsApp voice; Google's sync limit (1 min) is checked by Google
const AUDIO_MIME = /^audio\/(ogg|opus)\b/; // WhatsApp voice notes: "audio/ogg; codecs=opus"
const OPUS_RATES = [8000, 12000, 16000, 24000, 48000];
const MIN_CONFIDENCE = 0.3;               // below this the words are probably wrong: ask again instead of guessing

// Words visitors say that a general model may mishear: given as hints.
const MELA_PHRASES = ['सोनपुर मेला', 'सोनपुर', 'हरिहरनाथ', 'हरिहर क्षेत्र', 'मेला', 'पुलिस स्टेशन', 'थाना', 'शौचालय', 'टॉयलेट',
  'अस्पताल', 'डॉक्टर', 'पार्किंग', 'घाट', 'काली घाट', 'पानी', 'खाना', 'कार्यक्रम', 'प्रोग्राम', 'कंट्रोल रूम', 'हेल्पलाइन',
  'खोया पाया', 'मीना बाज़ार', 'घोड़ा बाज़ार', 'हाथी बाज़ार', 'चिड़िया बाज़ार', 'पशु', 'गंडक', 'गंगा', 'नखास'];

// The rate the voice note was recorded at, from its OGG "OpusHead" header
// (Google needs it for OGG_OPUS). Unknown/odd values -> 48000 (Opus's own rate).
function opusSampleRate(buf) {
  if (!buf || buf.length < 64) return 48000;
  const at = buf.indexOf('OpusHead');
  if (at < 0 || at + 16 > buf.length) return 48000;
  const rate = buf.readUInt32LE(at + 12);
  if (OPUS_RATES.includes(rate)) return rate;
  return OPUS_RATES.find((r) => r >= rate) || 48000;
}

function sttRequest(audioB64, sampleRate, opts = {}) {
  const alt = (opts.altLanguages || []).filter(Boolean);
  return {
    config: {
      encoding: 'OGG_OPUS',
      sampleRateHertz: sampleRate,
      languageCode: opts.language || 'hi-IN',
      ...(alt.length ? { alternativeLanguageCodes: alt.slice(0, 3) } : {}),
      maxAlternatives: 1,
      profanityFilter: true,
      speechContexts: [{ phrases: MELA_PHRASES.concat(opts.phrases || []).slice(0, 500) }],
    },
    audio: { content: audioB64 },
  };
}

// -> { text, confidence } (text '' when nothing was understood)
function sttResult(resp) {
  const parts = [];
  let conf = null;
  for (const r of (resp && resp.results) || []) {
    const a = (r.alternatives || [])[0];
    if (!a || !a.transcript) continue;
    parts.push(String(a.transcript).trim());
    if (typeof a.confidence === 'number' && a.confidence > 0) conf = conf == null ? a.confidence : Math.min(conf, a.confidence);
  }
  return { text: parts.join(' ').replace(/\s+/g, ' ').trim().slice(0, 500), confidence: conf };
}

// Service-account access token (RS256 JWT -> OAuth token), same as the sheet sync.
async function googleToken(saRaw, scope, crypto, http, tokenUrlOverride) {
  const raw = String(saRaw || '').trim();
  if (!raw) throw new Error('GOOGLE_SA_JSON is not set');
  const sa = JSON.parse(raw.startsWith('{') ? raw : Buffer.from(raw, 'base64').toString('utf8'));
  const tokenUrl = tokenUrlOverride || sa.token_uri || 'https://oauth2.googleapis.com/token';
  const now = Math.floor(Date.now() / 1000);
  const b64u = (o) => Buffer.from(typeof o === 'string' ? o : JSON.stringify(o)).toString('base64url');
  const unsigned = `${b64u({ alg: 'RS256', typ: 'JWT' })}.${b64u({ iss: sa.client_email, scope, aud: tokenUrl, iat: now, exp: now + 3600 })}`;
  const jwt = `${unsigned}.${crypto.createSign('RSA-SHA256').update(unsigned).sign(sa.private_key).toString('base64url')}`;
  const tok = await http({ method: 'POST', url: tokenUrl, timeout: 10000, json: true,
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: `grant_type=${encodeURIComponent('urn:ietf:params:oauth:grant-type:jwt-bearer')}&assertion=${jwt}` });
  return tok.access_token;
}

// Short error code for the log (never the audio or the token).
function why(e) {
  const r = (e && e.response) || {};
  return String((e && (e.httpCode || e.statusCode || e.status || e.code)) || r.status || r.statusCode || 'error').slice(0, 20);
}

// The voice note's bytes from WhatsApp -> { buf } or { error }.
async function downloadAudio(mediaId, mime, g, http) {
  if (!mediaId) return { error: 'no_media' };
  if (mime && !AUDIO_MIME.test(String(mime))) return { error: 'unsupported_audio' };
  const graphBase = `${g.base || 'https://graph.facebook.com'}/${g.version || 'v23.0'}`;
  let meta;
  try {
    meta = await http({ method: 'GET', url: `${graphBase}/${mediaId}`, json: true, timeout: 10000, headers: { Authorization: `Bearer ${g.token}` } });
  } catch (e) {
    return { error: `media_lookup_failed:${why(e)}` };
  }
  if (!meta || !meta.url) return { error: 'media_lookup_failed' };
  if (meta.file_size && Number(meta.file_size) > MAX_AUDIO_BYTES) return { error: 'too_long' };
  try {
    const res = await http({ method: 'GET', url: meta.url, timeout: 20000, encoding: 'arraybuffer', returnFullResponse: true,
      headers: { Authorization: `Bearer ${g.token}` } });
    if (!res || !res.body || typeof res.body === 'string') return { error: 'download_failed' };
    const buf = Buffer.isBuffer(res.body) ? res.body : Buffer.from(res.body);
    return buf.length > MAX_AUDIO_BYTES ? { error: 'too_long' } : { buf };
  } catch (e) {
    return { error: `download_failed:${why(e)}` };
  }
}

// Sarvam speech-to-text reply (n8n HTTP Request node, full response) ->
// { text } or { error }. Sarvam gives no confidence score: an empty transcript
// is the only "not understood".
function sarvamResult(res) {
  const r = res || {};
  const status = Number(r.statusCode || 0);
  const body = r.body && typeof r.body === 'object' ? r.body : (() => { try { return JSON.parse(r.body); } catch (e) { return {}; } })();
  if (status && status >= 300) {
    const msg = JSON.stringify(body || {}).toLowerCase();
    return { error: /duration|too long|exceed|30 sec|limit/.test(msg) && status === 400 ? 'too_long' : `stt_failed:${status}` };
  }
  if (r.error && !status) return { error: 'stt_failed:network' };
  const text = String((body && (body.transcript || (body.data && body.data.transcript))) || '').replace(/\s+/g, ' ').trim().slice(0, 500);
  return text ? { text, language: body.language_code || null } : { error: 'not_understood' };
}

// One voice note -> { text, confidence } or { error }  (Google provider)
// cfg: { graph: {base, version, token}, saJson, tokenUrl, sttBase, language, altLanguages }
async function transcribeVoice(mediaId, mime, cfg, http, crypto) {
  if (!mediaId) return { error: 'no_media' };
  if (mime && !AUDIO_MIME.test(String(mime))) return { error: 'unsupported_audio' };
  const g = cfg.graph || {};
  const graphBase = `${g.base || 'https://graph.facebook.com'}/${g.version || 'v23.0'}`;
  let meta;
  try {
    meta = await http({ method: 'GET', url: `${graphBase}/${mediaId}`, json: true, timeout: 10000, headers: { Authorization: `Bearer ${g.token}` } });
  } catch (e) {
    return { error: `media_lookup_failed:${why(e)}` };
  }
  if (!meta || !meta.url) return { error: 'media_lookup_failed' };
  if (meta.file_size && Number(meta.file_size) > MAX_AUDIO_BYTES) return { error: 'too_long' };
  let buf;
  try {
    // 'arraybuffer': n8n's binary download option (see core/media.js)
    const res = await http({ method: 'GET', url: meta.url, timeout: 20000, encoding: 'arraybuffer', returnFullResponse: true,
      headers: { Authorization: `Bearer ${g.token}` } });
    if (!res || !res.body || typeof res.body === 'string') return { error: 'download_failed' };
    buf = Buffer.isBuffer(res.body) ? res.body : Buffer.from(res.body);
  } catch (e) {
    return { error: `download_failed:${why(e)}` };
  }
  if (buf.length > MAX_AUDIO_BYTES) return { error: 'too_long' };
  let resp;
  try {
    const token = await googleToken(cfg.saJson, 'https://www.googleapis.com/auth/cloud-platform', crypto, http, cfg.tokenUrl);
    resp = await http({ method: 'POST', url: `${cfg.sttBase || 'https://speech.googleapis.com'}/v1/speech:recognize`, json: true, timeout: 15000,
      headers: { Authorization: `Bearer ${token}` },
      body: sttRequest(buf.toString('base64'), opusSampleRate(buf), { language: cfg.language, altLanguages: cfg.altLanguages }) });
  } catch (e) {
    const msg = String((e && (e.message || (e.response && JSON.stringify(e.response.body)))) || '');
    return { error: /too long|exceeds|duration/i.test(msg) ? 'too_long' : `stt_failed:${why(e)}` };
  }
  const out = sttResult(resp);
  if (!out.text) return { error: 'not_understood' };
  if (out.confidence != null && out.confidence < MIN_CONFIDENCE) return { error: 'low_confidence', text: out.text, confidence: out.confidence };
  return out;
}

// Per-day cap (all citizens together) kept in the workflow's static data:
// speech-to-text is billed per second, and a flood must not run up the bill.
function voiceAllowed(store, cap, todayIst) {
  if (!(cap > 0)) return false;
  if (!store) return true;
  if (store.voice_day !== todayIst) { store.voice_day = todayIst; store.voice_n = 0; }
  if (store.voice_n >= cap) return false;
  store.voice_n += 1;
  return true;
}

if (typeof module !== 'undefined') {
  module.exports = { transcribeVoice, downloadAudio, sarvamResult, sttRequest, sttResult, opusSampleRate, googleToken, voiceAllowed, MELA_PHRASES, MAX_AUDIO_BYTES };
}
