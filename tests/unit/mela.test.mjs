// Unit tests for the Sonpur Mela service (n8n/src/services/mela.js, mela_sheet.js)
// using the real 2025 sample converted by scripts/convert_samples.py.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { validateMelaSheet, normPhone, normDate, normTime } = require('../../n8n/src/services/mela_sheet.js');
const { melaHandle, melaQaRequest, melaQaFinish, currentShift, haversineM, detectTopic } = require('../../n8n/src/services/mela.js');
const { validateServiceOutput } = require('../../n8n/src/core/contract.js');
const { renderMessage } = require('../../n8n/src/core/render.js');

const RAW = JSON.parse(fs.readFileSync(new URL('../fixtures/mela_sheet.json', import.meta.url), 'utf8'));
const clone = (x) => JSON.parse(JSON.stringify(x));

// The sample with the one known bad phone fixed and a helpline/centre set - what the data owner would do.
function cleanTabs() {
  const t = clone(RAW);
  const cols = t.places[0];
  for (const row of t.places) if (row[cols.indexOf('s2_phone')] === '709095094') row[cols.indexOf('s2_phone')] = '7090950940';
  const set = (k, v) => { const r = t.settings.find((x) => x[0] === k); r[1] = v; };
  set('public_helpline_1', '06158-221084');
  set('mela_center_lat', '25.6920'); set('mela_center_lon', '85.1750'); set('mela_radius_km', '5');
  return t;
}
function snapshot(tabs = cleanTabs(), coords = {}) {
  const r = validateMelaSheet(tabs, {});
  assert.deepEqual(r.errors, []);
  const d = r.data;
  for (const p of d.places) if (coords[p.id]) Object.assign(p, coords[p.id], { coord_source: 'captured' });
  return { ...d };
}
const req = (input, over = {}) => ({ wa_hash: 'h', lang: 'en', state: null, context: {}, is_admin: false,
  now_ist: '2025-11-23 15:10', now_iso: '2025-11-23T09:40:00Z', input: { id: null, text: null, ...input }, ...over });
const ok = (o) => { assert.deepEqual(validateServiceOutput(o, 'mela'), []); for (const m of o.messages) renderMessage(m, '91x'); return o; };
const body = (o, i = 0) => o.messages[i].body;

// --- sheet validation ------------------------------------------------------------
test('sheet: the real sample is rejected only for the 9-digit phone (D3)', () => {
  const r = validateMelaSheet(RAW, { today: '2026-09-24' });
  assert.equal(r.errors.length, 1);
  assert.match(r.errors[0].msg, /709095094/);
  assert.equal(r.errors[0].row, 14);
  assert.ok(r.warnings.some((w) => /public_helpline_1/.test(w.msg)));
  assert.ok(r.warnings.some((w) => /next 30 days/.test(w.msg)));
});

test('sheet: cleaned sample converts every source row', () => {
  const r = validateMelaSheet(cleanTabs(), {});
  const byCat = r.data.places.reduce((a, p) => ({ ...a, [p.category]: (a[p.category] || 0) + 1 }), {});
  assert.deepEqual(byCat, { thana: 14, health_centre: 5, vet_camp: 11, parking: 18, ghat: 6 });
  assert.equal(r.data.duty.filter((d) => d.shift_no != null).length, (14 + 5) * 3);
  assert.equal(r.data.events.length, 14);
  assert.deepEqual([...new Set(r.data.control.map((c) => c.desk))], ['Magistrate', 'Police', 'Sanitation & Water', 'Electricity', 'Health']);
  const sanitation = r.data.control.filter((c) => c.desk === 'Sanitation & Water');
  assert.equal(sanitation.length, 1); assert.equal(sanitation[0].shift_no, null);
  assert.deepEqual(sanitation[0].phones, ['8709898293', '7970663565']);
});

test('sheet: rules - Kruti Dev, landline, verified, placeholders, missing tab, bad coords', () => {
  const t = cleanTabs();
  const c = t.places[0];
  t.places[1][c.indexOf('name_en')] = "Nakhas ¼u[kk'k½";
  t.places[2][c.indexOf('s1_phone')] = '6152232660';
  t.places[3][c.indexOf('lat')] = '85.17'; t.places[3][c.indexOf('lon')] = '25.69';
  const r = validateMelaSheet(t, {});
  assert.ok(r.errors.some((e) => /Kruti Dev/.test(e.msg)));
  assert.ok(r.errors.some((e) => /not a location in India/.test(e.msg)));
  assert.ok(r.warnings.some((w) => /missing its leading 0/.test(w.msg)));
  const v = validateMelaSheet(cleanTabs(), { requireVerified: true });
  assert.equal(v.data.places.length, 0, 'nothing verified yet in the sample');
  assert.ok(v.warnings.some((w) => /not marked verified/.test(w.msg)));
  const ph = cleanTabs(); ph.events[1][3] = 'DUMMY-TEST-DATA show';
  assert.ok(validateMelaSheet(ph, { rejectPlaceholders: true }).errors.some((e) => /DUMMY/.test(e.msg)));
  const missing = cleanTabs(); delete missing.control_room;
  assert.match(validateMelaSheet(missing, {}).errors[0].msg, /control_room" is missing/);
});

test('sheet: phone/date/time normalisation', () => {
  assert.equal(normPhone('+91 94310 12345').value, '9431012345');
  assert.equal(normPhone('06152-240001').value, '06152-240001');
  assert.ok(normPhone('12345').error);
  assert.equal(normPhone('112').value, '112');
  assert.equal(normDate('24/11/2026'), '2026-11-24');
  assert.equal(normDate('2026-11-24'), '2026-11-24');
  assert.equal(normDate('31/02/2026'), null);
  assert.equal(normTime('6:30 PM'), '18:30');
  assert.equal(normTime('06:00'), '06:00');
  assert.equal(normTime('25:00'), null);
});

// --- shifts ------------------------------------------------------------------------
test('shift boundaries including shift 3 across midnight', () => {
  const s = snapshot();
  const at = (hm) => currentShift(s, `2025-11-23 ${hm}`).no;
  assert.deepEqual(['05:59', '06:00', '13:59', '14:00', '21:59', '22:00', '00:00', '02:00'].map(at), [3, 1, 1, 2, 2, 3, 3, 3]);
});

// --- screens ---------------------------------------------------------------------------
test('menu: data-driven, max 10 rows, near hidden until coordinates exist', () => {
  const m = ok(melaHandle(req({ kind: 'open', id: 'mela:open' }), snapshot()));
  const ids = m.messages[0].sections[0].rows.map((r) => r.id);
  assert.ok(ids.length <= 10);
  assert.deepEqual(ids, ['mela:today', 'mela:control', 'mela:cat:thana', 'mela:cat:health_centre', 'mela:cat:vet_camp', 'mela:cat:parking', 'mela:cat:ghat', 'mela:ask']);
  const withCoords = ok(melaHandle(req({ kind: 'open', id: 'mela:open' }), snapshot(undefined, { TH01: { lat: 25.69, lon: 85.17 } })));
  assert.ok(withCoords.messages[0].sections[0].rows.some((r) => r.id === 'mela:near'));
  const hi = ok(melaHandle(req({ kind: 'open', id: 'mela:open' }, { lang: 'hi' }), snapshot()));
  assert.match(hi.messages[0].body, /सोनपुर मेला/);
});

test("today's programme, next programme, schedule", () => {
  const s = snapshot();
  const t = ok(melaHandle(req({ kind: 'list', id: 'mela:today' }), s));
  assert.match(body(t), /Programme – 23 Nov/); assert.match(body(t), /Monali Thakur/);
  const gap = ok(melaHandle(req({ kind: 'list', id: 'mela:today' }, { now_ist: '2025-12-04 10:00' }), s));
  assert.match(body(gap), /No programme is listed for today/); assert.match(body(gap), /5 Dec/);
  const after = ok(melaHandle(req({ kind: 'list', id: 'mela:today' }, { now_ist: '2026-01-10 10:00' }), s));
  assert.match(body(after), /announced soon/);
  const sch = ok(melaHandle(req({ kind: 'button', id: 'mela:schedule' }), s));
  assert.match(body(sch), /\*7 Dec\*[\s\S]*Anuradha Paudwal/);
});

test('thana card shows the on-duty in-charge for the current shift; roster shows all', () => {
  const s = snapshot();
  const now = ok(melaHandle(req({ kind: 'list', id: 'mela:cat:thana' }), s)); // 15:10 -> shift 2
  assert.match(body(now), /on duty now \(Shift 2, 14:00–22:00\)/);
  assert.match(body(now), /Nakash Thana\*\n👤 Rakesh Kumar – 📞 6207037337/);
  assert.doesNotMatch(body(now), /Vishal Anand/, 'shift-1 officer not shown during shift 2');
  assert.match(body(now), /06158-221084/, 'helpline on every card');
  assert.deepEqual(now.messages[1].buttons.map((b) => b.id), ['mela:roster:thana', 'core:menu']);
  const night = ok(melaHandle(req({ kind: 'list', id: 'mela:cat:thana' }, { now_ist: '2025-11-24 02:00' }), s));
  assert.match(body(night), /Srijan Mishra/);
  const roster = ok(melaHandle(req({ kind: 'button', id: 'mela:roster:thana' }), s));
  assert.match(body(roster), /Shift 1 \(06:00–14:00\): Vishal Anand[\s\S]*Shift 3 \(22:00–06:00\): Srijan Mishra/);
  const vet = ok(melaHandle(req({ kind: 'list', id: 'mela:cat:vet_camp' }), s));
  assert.match(body(vet), /Dr\. Vijay Prasad Mandal – 📞 9155688071/);
  assert.equal(vet.messages[1].buttons.length, 1, 'no shifts, no coords -> only the menu button');
});

test('control room: helpline first, desks on duty now, merged desks on every shift', () => {
  const s = snapshot();
  const c = ok(melaHandle(req({ kind: 'list', id: 'mela:control' }, { now_ist: '2025-11-23 23:00' }), s));
  assert.match(body(c), /control room:\* 06158-221084/);
  assert.match(body(c), /Magistrate\*: Shri Rajesh Kumar/);
  assert.match(body(c), /Sanitation & Water\*: Shri Nikhil Kumar[^\n]*8709898293, 7970663565/);
  const all = ok(melaHandle(req({ kind: 'button', id: 'mela:roster:control' }), s));
  assert.equal((body(all).match(/Sanitation & Water/g) || []).length, 3, 'all-day desk listed in every shift');
});

test('near me: location request, nearest three, outside the Mela, landmark fallback', () => {
  const coords = { TH01: { lat: 25.6930, lon: 85.1760 }, TH02: { lat: 25.7000, lon: 85.1900 }, TH03: { lat: 25.6922, lon: 85.1752 }, TH04: { lat: 25.6800, lon: 85.1600 },
    GH01: { lat: 25.6925, lon: 85.1755 }, HC01: { lat: 25.6935, lon: 85.1745 } };
  const s = snapshot(undefined, coords);
  const ask = ok(melaHandle(req({ kind: 'text', text: 'police near me' }), s));
  assert.equal(ask.messages[0].type, 'location_request');
  assert.equal(ask.next_state, 'mela.await_location'); assert.deepEqual(ask.context, { near_cat: 'thana' });
  const res = ok(melaHandle(req({ kind: 'location', lat: 25.6921, lon: 85.1751 }, { state: 'mela.await_location', context: { near_cat: 'thana' } }), s));
  assert.match(body(res), /1\. \*Theater Thana\* – ≈10 m[\s\S]*2\. \*Nakash Thana\* – ≈[\d]+ m[\s\S]*3\. /);
  assert.match(body(res), /destination=25\.6922,85\.1752&travelmode=walking/);
  assert.doesNotMatch(body(res), /origin=/, 'citizen coordinates never in a link');
  assert.equal(res.messages[1].type, 'location');
  const far = ok(melaHandle(req({ kind: 'location', lat: 25.6, lon: 85.1 }, { state: 'mela.await_location', context: { near_cat: 'thana' } }), s));
  assert.match(body(far), /outside the Mela area/);
  const land = ok(melaHandle(req({ kind: 'text', text: 'kali ghat' }, { state: 'mela.await_location', context: { near_cat: 'thana' } }), s));
  assert.match(body(land), /Nearest police station/);
  const miss = ok(melaHandle(req({ kind: 'text', text: 'xyzzy' }, { state: 'mela.await_location', context: { near_cat: 'thana' } }), s));
  assert.equal(miss.messages[0].type, 'location_request');
  const plain = ok(melaHandle(req({ kind: 'location', lat: 25.6921, lon: 85.1751 }), s));
  assert.match(body(plain), /Nearest police station[\s\S]*Nearest health centre/);
  const noCoords = ok(melaHandle(req({ kind: 'button', id: 'mela:near:vet_camp' }), s));
  assert.match(body(noCoords), /starts soon/);
});

test('free text: keywords, place names, LLM intent, questions go to Q&A', () => {
  const s = snapshot();
  assert.match(body(ok(melaHandle(req({ kind: 'text', text: 'thana ka number' }), s))), /Police stations/);
  assert.match(body(ok(melaHandle(req({ kind: 'text', text: 'डॉक्टर चाहिए' }, { lang: 'hi' }), s))), /स्वास्थ्य केंद्र/);
  assert.match(body(ok(melaHandle(req({ kind: 'text', text: 'aaj ka program' }), s))), /Programme – 23 Nov/);
  assert.match(body(ok(melaHandle(req({ kind: 'text', text: 'Meena Bazar' }), s))), /Meena Bazar/);
  assert.match(body(ok(melaHandle(req({ kind: 'text', text: 'helpline number' }), s))), /control room/);
  const intent = ok(melaHandle(req({ kind: 'text', text: 'where do i keep my scooty', intent: { subtype: 'parking', slots: {} } }), s));
  assert.match(body(intent), /Parking/);
  const q = melaHandle(req({ kind: 'text', text: 'what is the history of this fair?' }), s);
  assert.deepEqual(q.qa_request, { question: 'what is the history of this fair?' });
  const q2 = melaHandle(req({ kind: 'text', text: 'Harihar Nath kab bana?' }, { state: 'mela.await_question' }), s);
  assert.ok(q2.qa_request);
  assert.deepEqual(detectTopic('bhai paas me police chowki kahan hai'), { near: true, topic: 'thana' });
  assert.deepEqual(detectTopic('police station kahan hai'), { near: false, topic: 'thana' }, '"where" is not "near me"');
  assert.equal(detectTopic('haathi ka doctor').topic, 'vet_camp');
  assert.equal(detectTopic('control room ka number').topic, 'control');
  assert.match(body(ok(melaHandle(req({ kind: 'text', text: 'mera bachcha kho gaya' }), s))), /control room/, 'lost child -> control room');
});

test('admin coordinate capture: pin -> category -> site -> location -> confirm -> save', () => {
  const s = snapshot();
  const a = (input, over = {}) => ok(melaHandle(req(input, { is_admin: true, ...over }), s));
  const menu = a({ kind: 'text', text: 'pin' });
  assert.equal(menu.messages[0].sections[0].rows[0].id, 'mela:adm:cat:thana:0');
  assert.equal(menu.messages[0].sections[0].rows[0].description, '0/14 pinned');
  const sites = a({ kind: 'list', id: 'mela:adm:cat:thana:0' });
  assert.equal(sites.messages[0].sections[0].rows.length, 10, '9 sites + More');
  assert.equal(a({ kind: 'list', id: 'mela:adm:cat:thana:1' }).messages[0].sections[0].rows.length, 5);
  const askLoc = a({ kind: 'list', id: 'mela:adm:place:TH01' });
  assert.equal(askLoc.next_state, 'mela.adm_await_location');
  const confirm = a({ kind: 'location', lat: 25.69, lon: 85.17 }, { state: 'mela.adm_await_location', context: askLoc.context });
  assert.equal(confirm.messages[0].type, 'location');
  const saved = a({ kind: 'button', id: 'mela:adm:save' }, { state: confirm.next_state, context: confirm.context });
  assert.deepEqual(saved.effects, [{ type: 'save_coords', place_id: 'TH01', lat: 25.69, lon: 85.17 }]);
  const status = a({ kind: 'text', text: 'pin status' });
  assert.match(body(status), /Police stations: 0\/14 pinned/);
  const citizen = melaHandle(req({ kind: 'text', text: 'pin' }), s);
  assert.ok(citizen.qa_request, 'non-admin "pin" is just a question');
});

test('Q&A request and answer handling', () => {
  const s = snapshot();
  const r = melaQaRequest('history?', 'Sonpur Mela is held at Harihar Kshetra.', s);
  assert.equal(r.model, 'claude-haiku-4-5');
  assert.match(r.system, /Harihar Kshetra/);
  assert.deepEqual(r.output_config.format.schema.required, ['answerable', 'answer']);
  const resp = (d) => ({ stop_reason: 'end_turn', usage: { input_tokens: 900, output_tokens: 80 }, content: [{ type: 'text', text: JSON.stringify(d) }] });
  const good = ok(melaQaFinish(req({}), s, resp({ answerable: true, answer: 'It is at Harihar Kshetra.' })));
  assert.equal(body(good), 'It is at Harihar Kshetra.'); assert.equal(good.llm_tokens, 980); assert.equal(good.done, true);
  const bad = ok(melaQaFinish(req({}, { lang: 'hi' }), s, resp({ answerable: false, answer: '' })));
  assert.match(body(bad), /जानकारी मेरे पास नहीं/); assert.match(body(bad), /06158-221084/);
  assert.equal(ok(melaQaFinish(req({}), s, { error: { message: 'timeout' } })).log.resolved, false);
});

test('empty data never crashes and never dead-ends', () => {
  const empty = { places: [], duty: [], control: [], events: [], guidelines: [], settings: {} };
  for (const id of ['mela:open', 'mela:today', 'mela:schedule', 'mela:control', 'mela:cat:thana', 'mela:near', 'mela:rules', 'mela:near:thana', 'mela:unknown']) {
    const o = ok(melaHandle(req({ kind: 'list', id }), empty));
    assert.ok(o.messages.length > 0, id);
  }
  assert.ok(ok(melaHandle(req({ kind: 'location', lat: 25.69, lon: 85.17 }), empty)).messages.length);
  assert.ok(haversineM(25.69, 85.17, 25.69, 85.17) === 0);
});
