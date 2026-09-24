// Unit tests for n8n/src/core. Run: node --test tests/unit
import { test } from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const core = (m) => require(`../../n8n/src/core/${m}.js`);
const { verifySignature } = core('signature');
const { explodeWebhook } = core('explode');
const { normalizeMessage, guessLang } = core('normalize');
const { decideRoute } = core('route');
const { buildMainMenu } = core('menu');
const { renderMessage, splitText, visibleText, LIMITS } = core('render');
const { extractPhones } = core('phone_guard');
const { validateServiceOutput } = core('contract');
const { buildClassifierRequest, parseClassifierResponse } = core('llm');

const svc = (key, order = 1, extra = {}) => ({
  service_key: key, id_prefix: key, title_en: key.toUpperCase(), title_hi: key, description_en: `${key} desc`,
  menu_order: order, workflow_id: `wf-${key}`, subtypes: {}, accepts_location: false, ...extra,
});
const T = {
  menu_prompt: { hi: 'चुनें', en: 'Choose' }, menu_button: { hi: 'सेवाएँ', en: 'Services' },
  menu_section: { hi: 'सेवाएँ', en: 'Services' }, btn_lang_other: { hi: '🌐 English', en: '🌐 हिंदी' },
  error_apology: { hi: 'माफ़', en: 'Sorry' },
};

// --- signature -------------------------------------------------------------
test('signature: valid, tampered, missing', () => {
  const body = '{"object":"whatsapp_business_account"}';
  const sig = 'sha256=' + crypto.createHmac('sha256', 's3cret').update(body).digest('hex');
  assert.equal(verifySignature(body, sig, 's3cret', crypto), true);
  assert.equal(verifySignature(Buffer.from(body), sig, 's3cret', crypto), true);
  assert.equal(verifySignature(body + ' ', sig, 's3cret', crypto), false);
  assert.equal(verifySignature(body, sig, 'other', crypto), false);
  assert.equal(verifySignature(body, undefined, 's3cret', crypto), false);
  assert.equal(verifySignature(body, 'sha256=zz', 's3cret', crypto), false);
  assert.equal(verifySignature(body, sig, '', crypto), false);
});

// --- explode ---------------------------------------------------------------
const msg = (id, from, extra) => ({ from, id, timestamp: '1', type: 'text', text: { body: 'hi' }, ...extra });
test('explode: batched entries/messages, statuses dropped', () => {
  const body = {
    object: 'whatsapp_business_account',
    entry: [
      { changes: [{ field: 'messages', value: { metadata: { phone_number_id: 'P' }, contacts: [{ wa_id: '91A' }], messages: [msg('m1', '91A'), msg('m2', '91A')] } }] },
      { changes: [{ field: 'messages', value: { metadata: { phone_number_id: 'P' }, statuses: [{ id: 'x', status: 'read' }] } }] },
      { changes: [{ field: 'messages', value: { metadata: { phone_number_id: 'P' }, messages: [msg('m3', '91B')] } }] },
    ],
  };
  const items = explodeWebhook(body);
  assert.deepEqual(items.map((i) => i.msg_id), ['m1', 'm2', 'm3']);
  assert.equal(items[2].wa_id, '91B');
  assert.equal(items[0].phone_number_id, 'P');
  assert.deepEqual(explodeWebhook({ object: 'page' }), []);
  assert.deepEqual(explodeWebhook(null), []);
});

// --- normalize -------------------------------------------------------------
test('normalize: all message kinds', () => {
  assert.deepEqual(
    (({ kind, text, lang_guess }) => ({ kind, text, lang_guess }))(normalizeMessage({ type: 'text', text: { body: '  पुलिस कहाँ है ' } })),
    { kind: 'text', text: 'पुलिस कहाँ है', lang_guess: 'hi' });
  assert.equal(normalizeMessage({ type: 'text', text: { body: 'thana kidhar' } }).lang_guess, 'en');
  assert.equal(normalizeMessage({ type: 'interactive', interactive: { type: 'button_reply', button_reply: { id: 'mela:today', title: 'T' } } }).id, 'mela:today');
  const l = normalizeMessage({ type: 'interactive', interactive: { type: 'list_reply', list_reply: { id: 'mela:cat:thana', title: 'Police' } } });
  assert.equal(l.kind, 'list'); assert.equal(l.id, 'mela:cat:thana');
  const loc = normalizeMessage({ type: 'location', location: { latitude: 25.68, longitude: '85.18' } });
  assert.equal(loc.kind, 'location'); assert.equal(loc.lon, 85.18);
  assert.equal(normalizeMessage({ type: 'audio', audio: {} }).kind, 'unsupported');
  assert.equal(normalizeMessage({ type: 'button', button: { payload: 'x:y', text: 'Y' } }).id, 'x:y');
  assert.equal(guessLang('123'), null);
});

// --- route -----------------------------------------------------------------
const services = [svc('mela', 1, { accepts_location: true }), svc('dir', 2)];
const route = (input, extra = {}) => decideRoute({ input, state: null, services, isAdmin: false, llmEnabled: true, ...extra });
test('route: precedence', () => {
  assert.equal(route({ kind: 'unsupported' }).action, 'unsupported');
  assert.equal(route({ kind: 'text', text: 'Hi!' }).action, 'menu');
  assert.equal(route({ kind: 'text', text: 'मेनू' }).action, 'menu');
  assert.equal(route({ kind: 'text', text: 'english' }).lang, 'en');
  assert.equal(route({ kind: 'button', id: 'core:menu' }).action, 'menu');
  assert.equal(route({ kind: 'button', id: 'lang:hi' }).lang, 'hi');
  assert.deepEqual(route({ kind: 'button', id: 'fb:down:mela' }), { action: 'feedback', rating: -1, service_key: 'mela' });
  assert.equal(route({ kind: 'list', id: 'dir:blk:p1' }).service.service_key, 'dir');
  assert.equal(route({ kind: 'button', id: 'gone:open' }).reason, 'stale_id');
  assert.equal(route({ kind: 'button', id: 'mela:adm:pin' }).action, 'not_allowed');
  assert.equal(route({ kind: 'button', id: 'mela:adm:pin' }, { isAdmin: true }).action, 'service');
  // session state owner receives free text
  assert.equal(route({ kind: 'text', text: 'Kali Ghat' }, { state: 'dir.search' }).service.service_key, 'dir');
  // location: state owner only if it accepts location, else the location handler
  assert.equal(route({ kind: 'location', lat: 1, lon: 2 }, { state: 'dir.search' }).service.service_key, 'mela');
  // free text: a registry keyword routes without the LLM
  const kw = [svc('mela', 1, { keywords: ['police', 'पुलिस'] }), svc('dir', 2, { keywords: ['bdo'] })];
  assert.equal(decideRoute({ input: { kind: 'text', text: 'Police station kahan hai?' }, services: kw, llmEnabled: true }).service.service_key, 'mela');
  assert.equal(decideRoute({ input: { kind: 'text', text: 'पुलिसवाले कहाँ हैं' }, services: kw, llmEnabled: true }).service.service_key, 'mela');
  assert.equal(decideRoute({ input: { kind: 'text', text: 'BDO Dighwara' }, services: kw, llmEnabled: true }).service.service_key, 'dir');
  assert.equal(decideRoute({ input: { kind: 'text', text: 'policeman' }, services: kw, llmEnabled: true }).action, 'llm', 'Latin keywords match whole words only');
  // free text: LLM when enabled, menu when not
  assert.equal(route({ kind: 'text', text: 'police near me' }).action, 'llm');
  assert.equal(route({ kind: 'text', text: 'police near me' }, { llmEnabled: false }).action, 'menu');
  // an old button from the session's service still routes by id, not by state
  assert.equal(route({ kind: 'button', id: 'mela:today' }, { state: 'dir.search' }).service.service_key, 'mela');
});

// --- menu ------------------------------------------------------------------
test('menu: single service opens directly; 2-3 buttons; >3 list', () => {
  assert.equal(buildMainMenu([svc('mela')], 'en', T).kind, 'open_service');
  const two = buildMainMenu([svc('mela', 1), svc('dir', 2)], 'hi', T).messages[0];
  assert.equal(two.type, 'buttons');
  assert.deepEqual(two.buttons.map((b) => b.id), ['mela:open', 'dir:open', 'lang:en']);
  const three = buildMainMenu([svc('c', 3), svc('a', 1), svc('b', 2)], 'en', T).messages[0];
  assert.deepEqual(three.buttons.map((b) => b.id), ['a:open', 'b:open', 'c:open']);
  const four = buildMainMenu([svc('a'), svc('b'), svc('c'), svc('d')], 'en', T).messages[0];
  assert.equal(four.type, 'list');
  assert.equal(four.sections[0].rows.length, 5);
  assert.equal(four.sections[0].rows[4].id, 'lang:hi');
  assert.equal(buildMainMenu([], 'en', T).messages[0].body, 'Sorry');
});

// --- render ----------------------------------------------------------------
test('render: limits enforced at the edges', () => {
  const long = 'x'.repeat(30);
  const [b] = renderMessage({ type: 'buttons', body: 'b', buttons: [1, 2, 3, 4].map((n) => ({ id: `m:${n}`, title: long })) }, '91A');
  assert.equal(b.interactive.action.buttons.length, 3);
  assert.equal(Array.from(b.interactive.action.buttons[0].reply.title).length, LIMITS.buttonTitle);
  const exact = 'y'.repeat(20);
  assert.equal(renderMessage({ type: 'buttons', body: 'b', buttons: [{ id: 'm:1', title: exact }] }, 'A')[0].interactive.action.buttons[0].reply.title, exact);
  const rows = Array.from({ length: 12 }, (_, n) => ({ id: `m:${n}`, title: 'r'.repeat(30), description: 'd'.repeat(80) }));
  const [l] = renderMessage({ type: 'list', body: 'b', button: 'Menu', sections: [{ title: 's'.repeat(30), rows: rows.slice(0, 6) }, { title: 'two', rows: rows.slice(6) }] }, 'A');
  const all = l.interactive.action.sections.flatMap((s) => s.rows);
  assert.equal(all.length, 10);
  assert.equal(Array.from(all[0].title).length, 24);
  assert.equal(Array.from(all[0].description).length, 72);
  assert.equal(Array.from(l.interactive.action.sections[0].title).length, 24);
  const hindi = 'पुलिस थाना और स्वास्थ्य केंद्र की जानकारी';
  const [h] = renderMessage({ type: 'buttons', body: 'b', buttons: [{ id: 'm:1', title: hindi }] }, 'A');
  assert.ok(Array.from(h.interactive.action.buttons[0].reply.title).length <= 20);
  const [bodyCut] = renderMessage({ type: 'buttons', body: 'z'.repeat(2000), buttons: [{ id: 'm:1', title: 't' }] }, 'A');
  assert.equal(Array.from(bodyCut.interactive.body.text).length, 1024);
});

test('render: long text split, location, location_request', () => {
  const para = ('line of text\n').repeat(500); // ~6500 chars
  const parts = renderMessage({ type: 'text', body: para }, 'A');
  assert.ok(parts.length >= 2);
  for (const p of parts) assert.ok(Array.from(p.text.body).length <= 4096);
  assert.equal(splitText('short').length, 1);
  const [loc] = renderMessage({ type: 'location', lat: 25.6, lon: 85.1, name: 'Kali Ghat' }, 'A');
  assert.equal(loc.location.latitude, 25.6);
  const [req] = renderMessage({ type: 'location_request', body: 'Send location' }, 'A');
  assert.equal(req.interactive.type, 'location_request_message');
  assert.throws(() => renderMessage({ type: 'video' }, 'A'));
  assert.match(visibleText(renderMessage({ type: 'buttons', body: 'Body', buttons: [{ id: 'm:1', title: 'Btn' }] }, 'A')[0]), /Body\nBtn/);
});

// --- phone guard -----------------------------------------------------------
test('phone guard: finds phones, ignores dates/times/short numbers', () => {
  const text = 'Call 9431012345 or +91 94310 12345 or 06152-240001. Date 2026-11-24, 06:00-14:00, 14 thanas, 350 m, emergency 112, lat 25.6789,85.1234';
  assert.deepEqual(extractPhones(text).sort(), ['06152240001', '9431012345', '919431012345'].sort());
  assert.deepEqual(extractPhones(''), []);
  assert.deepEqual(extractPhones('https://www.google.com/maps/dir/?api=1&destination=25.678912,85.123456&travelmode=walking'), []);
  assert.deepEqual(extractPhones('https://wa.me/919431012345'), ['919431012345']);
  // regression: a number at the end of a line must not fuse with the next list number
  assert.deepEqual(extractPhones('👤 Ajay – 📞 6201113074\n\n7. *Bajrang Chowk*\n👤 X – 📞 9471451376'), ['6201113074', '9471451376']);
});

// --- contract --------------------------------------------------------------
test('contract: valid output passes, violations reported', () => {
  const good = { messages: [{ type: 'text', body: 'ok' }, { type: 'buttons', body: 'b', buttons: [{ id: 'mela:x', title: 't' }, { id: 'core:menu', title: 'm' }] }], next_state: 'mela.wait', context: {}, done: true };
  assert.deepEqual(validateServiceOutput(good, 'mela'), []);
  const bad = { messages: [{ type: 'buttons', body: 'b', buttons: [{ id: 'dir:x', title: 't' }] }, { type: 'gif' }], next_state: 'dir.x', done: 'yes' };
  const errs = validateServiceOutput(bad, 'mela');
  assert.equal(errs.length, 4);
  assert.deepEqual(validateServiceOutput(null, 'mela'), ['output is not an object']);
});

// --- llm -------------------------------------------------------------------
test('llm: request shape and response parsing', () => {
  const req = buildClassifierRequest('police near me', [svc('mela', 1, { subtypes: { near: 'nearest facility' } })]);
  assert.equal(req.model, 'claude-haiku-4-5');
  assert.equal(req.output_config.format.type, 'json_schema');
  assert.deepEqual(req.output_config.format.schema.properties.service_key.enum, ['mela', 'none']);
  assert.match(req.system, /subtypes:\n    - near: nearest facility/);
  const ok = (data, stop = 'end_turn') => ({ stop_reason: stop, usage: { input_tokens: 100, output_tokens: 20 }, content: [{ type: 'text', text: JSON.stringify(data) }] });
  const slots = { place: '', category: 'thana', date: '', block: '', department: '' };
  const r = parseClassifierResponse(ok({ service_key: 'mela', subtype: 'near', slots, lang: 'en', confidence: 0.9 }), [svc('mela')]);
  assert.equal(r.ok, true); assert.equal(r.tokens, 120); assert.deepEqual(r.slots, { category: 'thana' });
  assert.equal(parseClassifierResponse(ok({ service_key: 'mela', subtype: 'near', slots, lang: 'en', confidence: 0.4 }), [svc('mela')]).reason, 'low_confidence');
  assert.equal(parseClassifierResponse(ok({ service_key: 'none', subtype: '', slots, lang: 'hi', confidence: 0.9 }), [svc('mela')]).reason, 'no_service');
  assert.equal(parseClassifierResponse(ok({}, 'max_tokens'), [svc('mela')]).reason, 'stop_max_tokens');
  assert.equal(parseClassifierResponse({ error: { type: 'overloaded_error' } }, [svc('mela')]).reason, 'api_error');
  assert.equal(parseClassifierResponse({ stop_reason: 'end_turn', content: [{ type: 'text', text: 'nope' }] }, [svc('mela')]).reason, 'bad_json');
});

// --- services pass their own contract ---------------------------------------
test('services: echo and template satisfy the contract', () => {
  const { echoHandle } = require('../../n8n/src/services/echo.js');
  const { templateHandle } = require('../../n8n/src/services/template.js');
  const base = { wa_hash: 'h', lang: 'en', state: null, context: {}, is_admin: false };
  const cases = [
    { kind: 'open', id: 'echo:open' }, { kind: 'text', text: 'hello' }, { kind: 'button', id: 'echo:again' }, { kind: 'location', lat: 1, lon: 2 },
  ];
  for (const input of cases) assert.deepEqual(validateServiceOutput(echoHandle({ ...base, input }), 'echo'), [], JSON.stringify(input));
  assert.equal(echoHandle({ ...base, context: { last: 'x' }, input: { kind: 'button', id: 'echo:again' } }).messages[0].body, 'You said: x');
  assert.deepEqual(validateServiceOutput(templateHandle({ ...base, input: { kind: 'open' } }), 'tmpl'), []);
});
