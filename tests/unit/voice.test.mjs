// Voice notes: speech-to-text helpers (n8n/src/core/voice.js), the router's
// handling of a transcript, and - most important - that the spoken questions
// visitors actually ask reach the right Mela screen.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import crypto from 'node:crypto';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { transcribeVoice, sttRequest, sttResult, opusSampleRate, voiceAllowed } = require('../../n8n/src/core/voice.js');
const { normalizeMessage } = require('../../n8n/src/core/normalize.js');
const { decideTurn, finalizeTurn } = require('../../n8n/src/core/turn.js');
const { validateMelaSheet, MELA_TABS } = require('../../n8n/src/services/mela_sheet.js');
const { melaHandle, melaQaRequest } = require('../../n8n/src/services/mela.js');

const ogg = (rate, said) => Buffer.concat([Buffer.from('OggS'), Buffer.alloc(24), Buffer.from('OpusHead'),
  Buffer.from([1, 1, 0x38, 0x01]), (() => { const b = Buffer.alloc(4); b.writeUInt32LE(rate); return b; })(), Buffer.alloc(40),
  Buffer.from(said ? `SAY:${said}` : '')]);

test('OGG/Opus header: the recording rate Google needs; odd or missing headers fall back to 48 kHz', () => {
  assert.equal(opusSampleRate(ogg(16000)), 16000);
  assert.equal(opusSampleRate(ogg(48000)), 48000);
  assert.equal(opusSampleRate(ogg(44100)), 48000);
  assert.equal(opusSampleRate(ogg(11025)), 12000);
  assert.equal(opusSampleRate(Buffer.from('not an ogg file at all, just some bytes padding padding padding padding')), 48000);
  assert.equal(opusSampleRate(null), 48000);
});

test('speech-to-text request: Hindi first, English as alternative, Mela words as hints; results joined', () => {
  const r = sttRequest('QUJD', 16000, { language: 'hi-IN', altLanguages: ['en-IN', ''] });
  assert.deepEqual([r.config.encoding, r.config.sampleRateHertz, r.config.languageCode], ['OGG_OPUS', 16000, 'hi-IN']);
  assert.deepEqual(r.config.alternativeLanguageCodes, ['en-IN']);
  assert.ok(r.config.speechContexts[0].phrases.includes('शौचालय'));
  assert.equal(r.audio.content, 'QUJD');
  assert.deepEqual(sttResult({ results: [{ alternatives: [{ transcript: 'पुलिस स्टेशन ', confidence: 0.9 }] }, { alternatives: [{ transcript: ' कहाँ है', confidence: 0.8 }] }] }),
    { text: 'पुलिस स्टेशन कहाँ है', confidence: 0.8 });
  assert.deepEqual(sttResult({}), { text: '', confidence: null });
});

function fakeHttp(sttReply, opts = {}) {
  const calls = [];
  const http = async (req) => {
    calls.push(req);
    if (req.url.endsWith('/token')) return { access_token: 'tok' };
    if (req.url.includes('/v1/speech:recognize')) { if (sttReply instanceof Error) throw sttReply; return sttReply; }
    if (req.encoding === 'arraybuffer') return { body: opts.bytes || ogg(16000, 'x') };
    return { url: 'https://media/x', mime_type: 'audio/ogg; codecs=opus', file_size: opts.size || 2000 };
  };
  return { http, calls };
}
const { privateKey } = crypto.generateKeyPairSync('rsa', { modulusLength: 2048 });
const cfg = { graph: { token: 'wa' }, saJson: JSON.stringify({ client_email: 'bot@x.iam', private_key: privateKey.export({ type: 'pkcs8', format: 'pem' }) }),
  tokenUrl: 'https://oauth2/token', sttBase: 'https://stt' };

test('transcribe: download -> Google -> text; every failure is a short reason, never a crash', async () => {
  const ok = fakeHttp({ results: [{ alternatives: [{ transcript: 'टॉयलेट कहाँ है', confidence: 0.9 }] }] });
  assert.deepEqual(await transcribeVoice('M1', 'audio/ogg; codecs=opus', cfg, ok.http, crypto), { text: 'टॉयलेट कहाँ है', confidence: 0.9 });
  const sent = ok.calls.find((c) => c.url.includes('speech:recognize'));
  assert.equal(sent.headers.Authorization, 'Bearer tok'); assert.equal(sent.body.config.sampleRateHertz, 16000);
  assert.ok(!JSON.stringify(sent.body).includes('wa'), 'the WhatsApp token never goes to Google');
  const cases = [
    [fakeHttp({}), 'not_understood'],
    [fakeHttp({ results: [{ alternatives: [{ transcript: 'हम्म', confidence: 0.1 }] }] }), 'low_confidence'],
    [fakeHttp(Object.assign(new Error('Sync input too long. For audio longer than 1 min use LongRunningRecognize'), { statusCode: 400 })), 'too_long'],
    [fakeHttp(Object.assign(new Error('boom'), { statusCode: 503 })), 'stt_failed:503'],
    [fakeHttp({}, { size: 5 * 1024 * 1024 }), 'too_long'],
  ];
  for (const [h, want] of cases) assert.equal((await transcribeVoice('M1', 'audio/ogg', cfg, h.http, crypto)).error, want);
  assert.equal((await transcribeVoice('M1', 'video/mp4', cfg, ok.http, crypto)).error, 'unsupported_audio');
  assert.equal((await transcribeVoice(null, 'audio/ogg', cfg, ok.http, crypto)).error, 'no_media');
  const noSa = await transcribeVoice('M1', 'audio/ogg', { ...cfg, saJson: '' }, ok.http, crypto);
  assert.match(noSa.error, /^stt_failed/);
});

test('daily cap: counts per IST day, resets next day, 0 = no voice notes', () => {
  const store = {};
  assert.equal(voiceAllowed(store, 2, '2026-11-20'), true);
  assert.equal(voiceAllowed(store, 2, '2026-11-20'), true);
  assert.equal(voiceAllowed(store, 2, '2026-11-20'), false);
  assert.equal(voiceAllowed(store, 2, '2026-11-21'), true);
  assert.equal(voiceAllowed(store, 0, '2026-11-21'), false);
});

// ---- router -------------------------------------------------------------------------------
const TEMPLATES = Object.fromEntries(['welcome_notice', 'menu_prompt', 'menu_button', 'menu_section', 'unsupported', 'unsupported_flow',
  'voice_not_understood', 'rate_limited', 'error_apology', 'not_understood', 'feedback_prompt', 'feedback_thanks', 'lang_switched',
  'not_allowed', 'btn_helpful', 'btn_not_helpful', 'btn_menu', 'btn_lang_other'].map((k) => [k, { hi: `${k}_hi`, en: `${k}_en` }]));
const mela = { service_key: 'mela', id_prefix: 'mela', title_en: 'Sonpur Mela', title_hi: 'सोनपुर मेला', menu_order: 1, workflow_id: 'W', accepts_location: true,
  keywords: ['पुलिस', 'थाना'] };
const turn = (over = {}) => ({ is_dup: false, wa_hash: 'h', version: 1, lang: 'hi', state: null, context: {}, first_contact: false, is_admin: false,
  rate_limited: false, rate_notice: false, services: [mela], templates: TEMPLATES, settings: { home_service: 'mela' }, ...over });
const flags = { llmEnv: false, nowMs: Date.UTC(2026, 10, 20, 6) };
const item = (input) => ({ wa_id: '91900', msg_id: 'm', input });

test('normalize: a voice note stays "unsupported" (voice off) but keeps what is needed to transcribe it', () => {
  const n = normalizeMessage({ type: 'audio', audio: { id: 'A1', mime_type: 'audio/ogg; codecs=opus', voice: true } });
  assert.deepEqual([n.kind, n.raw_type, n.media_id, n.mime, n.voice_note], ['unsupported', 'audio', 'A1', 'audio/ogg; codecs=opus', true]);
});

test('router: a transcript is routed like typed text, the reply shows what was heard, logged as voice', () => {
  const input = { ...normalizeMessage({ type: 'text', text: { body: 'पुलिस स्टेशन कहाँ है' } }), voice: true, raw_type: 'audio' };
  const d = decideTurn(item(input), turn(), flags);
  assert.equal(d.action, 'service'); assert.equal(d.service.service_key, 'mela'); assert.equal(d.input.text, 'पुलिस स्टेशन कहाँ है');
  const f = finalizeTurn(d, { messages: [{ type: 'text', body: '👮 *पुलिस थाना*' }], next_state: null, context: {}, done: true, log: { subtype: 'thana' } });
  assert.equal(f.send.messages.length, 1, 'the echo rides on the answer: no extra message');
  assert.equal(f.send.messages[0].body, '🎤 “पुलिस स्टेशन कहाँ है”\n\n👮 *पुलिस थाना*');
  assert.equal(f.end.via, 'voice');
});

test('router: a voice note that could not be understood -> one clear ask-again, the menu, nothing lost mid-step', () => {
  const bad = { ...normalizeMessage({ type: 'audio', audio: { id: 'A1', mime_type: 'audio/ogg' } }), voice_error: 'low_confidence' };
  const d = decideTurn(item(bad), turn(), flags);
  assert.equal(d.action, 'service'); assert.equal(d.pre[0].body, 'voice_not_understood_hi'); assert.equal(d.unanswered_reason, 'voice:low_confidence');
  const mid = decideTurn(item(bad), turn({ state: 'mela.await_location', context: { near_cat: 'thana' } }), flags);
  assert.equal(mid.action, 'reply'); assert.equal(mid.state, 'mela.await_location'); assert.deepEqual(mid.context, { near_cat: 'thana' });
  // voice switched off: the usual "I can only read typed messages"
  const off = decideTurn(item(normalizeMessage({ type: 'audio', audio: { id: 'A1' } })), turn(), flags);
  assert.equal(off.pre[0].body, 'unsupported_hi');
});

// ---- what visitors actually say -----------------------------------------------------------------
const RAW = JSON.parse(fs.readFileSync(new URL('../fixtures/mela_sheet.json', import.meta.url), 'utf8'));
function snap(qa) {
  const t = JSON.parse(JSON.stringify(RAW));
  const c = t.places[0];
  for (const r of t.places) if (r[c.indexOf('s2_phone')] === '709095094') r[c.indexOf('s2_phone')] = '7090950940';
  t.settings.find((x) => x[0] === 'public_helpline_1')[1] = '06158-221084';
  t.attractions = [MELA_TABS.attractions,
    ['A01', 'food_court', 'Food Court', 'फ़ूड कोर्ट', 'Litti-chokha.', '', 'Gate 2', '', '', '', '', 'litti, khana, खाना', 'TRUE', 'TRUE', 'x'],
    ['A02', 'bazaar', 'Meena Bazaar', 'मीना बाज़ार', 'Clothes.', '', '', '', '', '', '', '', 'TRUE', 'TRUE', 'x']];
  // events re-dated around "today" so today's and the coming days' programmes exist
  t.events.slice(1).forEach((r, i) => { r[1] = new Date(Date.UTC(2026, 10, 18 + i)).toISOString().slice(0, 10); });
  t.events[t.events.length - 1][t.events[0].indexOf('is_highlight')] = 'TRUE'; // the final night's star
  // map pins for police and hospitals, so "near me" can ask for the location
  const pc = t.places[0];
  for (const r of t.places.slice(1)) if (['TH01', 'TH03', 'HC01'].includes(r[pc.indexOf('id')])) { r[pc.indexOf('lat')] = '25.6921'; r[pc.indexOf('lon')] = '85.1751'; }
  const toilet = pc.map(() => '');
  Object.assign(toilet, { [pc.indexOf('id')]: 'TL01', [pc.indexOf('category')]: 'toilet', [pc.indexOf('name_en')]: 'Gate 1 toilet block',
    [pc.indexOf('name_hi')]: 'गेट 1 शौचालय', [pc.indexOf('lat')]: '25.6930', [pc.indexOf('lon')]: '85.1700' });
  t.places.push(toilet);
  const v = validateMelaSheet(t, {});
  assert.deepEqual(v.errors, []);
  const d = v.data;
  return { ...d, qa_enabled: qa };
}
const ask = (text, s) => melaHandle({ wa_hash: 'h', lang: 'hi', state: null, context: {}, now_ist: '2026-11-20 10:00', input: { kind: 'text', text } }, s);

test('spoken questions (as Google writes them) reach the right screen - no AI needed', () => {
  const s = snap(false);
  const cases = [
    ['पुलिस स्टेशन कहाँ है', 'thana'],
    ['पुलिस स्टेशन कहाँ पे है', 'thana'],
    ['मेरे पास में पुलिस स्टेशन कहाँ पे है', 'near_ask'],   // asks for the location
    ['टॉयलेट कैसे जाना है', 'toilet'],
    ['अस्पताल कौन सा है मेरे पास में', 'near_ask'],
    ['मैं देखने के लिए क्या क्या है', 'visit'],
    ['मुझे खाना कहाँ पे मिलेगा', 'visit_place'],
    ['आज का प्रोग्राम क्या है', 'today'],
    ['अगले 3 दिन के सारे प्रोग्राम बताइए', 'schedule'],
    ['कौन से बड़े स्टार आने वाले हैं', 'schedule'],
    ['where is the police station', 'thana'],
  ];
  for (const [q, want] of cases) {
    const out = ask(q, s);
    assert.equal(out.log.subtype, want, `${q} -> ${out.log.subtype}`);
    if (want === 'near_ask') assert.equal(out.messages[0].type, 'location_request');
  }
  // "where is the toilet" with the older toilet_water category of the sample sheet
  assert.match(ask('टॉयलेट कैसे जाना है', s).messages.map((m) => m.body || '').join(), /शौचालय|Toilets/);
  // the schedule marks the big names
  assert.match(ask('कौन से बड़े स्टार आने वाले हैं', s).messages.map((m) => m.body || '').join('\n'), /⭐/);
});

test('"पानी की क्या व्यवस्था है" and other open questions go to the AI with the whole sheet (programme incl. stars)', () => {
  const s = snap(true);
  const out = ask('पानी की क्या व्यवस्था है', s);
  assert.ok(out.qa_request || /शौचालय/.test(out.messages.map((m) => m.body || '').join()), 'answered from the sheet: toilets & water, or the AI');
  const r = melaQaRequest('कौन से बड़े स्टार आने वाले हैं', '', s, null, '2026-11-20').system[0].text;
  assert.match(r, /⭐ 2026-12-01 .*Anuradha Paudwal/, 'highlights marked for the AI');
  assert.match(r, /2026-11-30/, 'the whole coming schedule, not just 3 days');
  assert.doesNotMatch(r, /2026-11-19/, 'past programmes left out');
});
