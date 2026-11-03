// Reduce any inbound WhatsApp message to the router's input shape:
// { kind, id, text, lat, lon, lang_guess }
const DEVANAGARI = /[ऀ-ॿ]/;
const LATIN = /[A-Za-z]/;

function guessLang(text) {
  if (!text) return null;
  if (DEVANAGARI.test(text)) return 'hi';
  if (LATIN.test(text)) return 'en';
  return null;
}

function normalizeMessage(message) {
  const m = message || {};
  // media_id is deliberately NOT `id`: route.js treats any non-null input.id as
  // a button/list interactive id (prefix-matched against a service); a raw
  // WhatsApp media id would wrongly fall into its "stale id -> menu" branch.
  const base = { kind: 'unsupported', id: null, media_id: null, mime: null, text: null, lat: null, lon: null, lang_guess: null, raw_type: m.type || null };
  switch (m.type) {
    case 'text': {
      const text = ((m.text || {}).body || '').trim();
      return { ...base, kind: 'text', text, lang_guess: guessLang(text) };
    }
    case 'image': {
      const i = m.image || {};
      return { ...base, kind: 'image', media_id: i.id || null, mime: i.mime_type || null, text: i.caption || null };
    }
    case 'document': {
      const d = m.document || {};
      return { ...base, kind: 'document', media_id: d.id || null, mime: d.mime_type || null, text: d.caption || null };
    }
    case 'interactive': {
      const i = m.interactive || {};
      if (i.type === 'button_reply' && i.button_reply) {
        return { ...base, kind: 'button', id: i.button_reply.id, text: i.button_reply.title };
      }
      if (i.type === 'list_reply' && i.list_reply) {
        return { ...base, kind: 'list', id: i.list_reply.id, text: i.list_reply.title };
      }
      return base;
    }
    case 'button': // quick-reply button on a template message
      return { ...base, kind: 'button', id: (m.button || {}).payload || null, text: (m.button || {}).text || null };
    case 'location': {
      const loc = m.location || {};
      const num = (v) => (v === null || v === undefined || v === '' ? NaN : Number(v)); // Number(null) is 0
      const lat = num(loc.latitude);
      const lon = num(loc.longitude);
      // a malformed pin must never reach distance maths or an admin capture
      if (!Number.isFinite(lat) || !Number.isFinite(lon) || Math.abs(lat) > 90 || Math.abs(lon) > 180) return base;
      return { ...base, kind: 'location', lat, lon };
    }
    default:
      return base; // audio, voice, image, video, sticker, document, contacts, reaction, ...
  }
}

if (typeof module !== 'undefined') module.exports = { normalizeMessage, guessLang };
