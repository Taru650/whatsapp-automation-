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
  const base = { kind: 'unsupported', id: null, text: null, lat: null, lon: null, lang_guess: null, raw_type: m.type || null };
  switch (m.type) {
    case 'text': {
      const text = ((m.text || {}).body || '').trim();
      return { ...base, kind: 'text', text, lang_guess: guessLang(text) };
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
      return { ...base, kind: 'location', lat: Number(loc.latitude), lon: Number(loc.longitude) };
    }
    default:
      return base; // audio, voice, image, video, sticker, document, contacts, reaction, ...
  }
}

if (typeof module !== 'undefined') module.exports = { normalizeMessage, guessLang };
