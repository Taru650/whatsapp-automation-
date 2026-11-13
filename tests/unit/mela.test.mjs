// Unit tests for the Sonpur Mela service (n8n/src/services/mela.js, mela_sheet.js)
// using the real 2025 sample converted by scripts/convert_samples.py.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { validateMelaSheet, normPhone, normDate, normTime } = require('../../n8n/src/services/mela_sheet.js');
const { melaHandle, melaQaRequest, melaQaFinish, qaReference, currentShift, haversineM, detectTopic, matchAttraction } = require('../../n8n/src/services/mela.js');
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

test('sheet: rows with only the active/verified tick-boxes (or updated_by) filled are blank rows, not errors', () => {
  const t = cleanTabs();
  const cols = t.places[0];
  const ticks = (active, verified, by = '') => cols.map((c) => (c === 'active' ? active : c === 'verified' ? verified : c === 'updated_by' ? by : ''));
  // a gap mid-table and a run of unticked rows at the end, as the real sheet had (9 Nov 2026)
  t.places.splice(5, 0, ticks('TRUE', 'TRUE'), ticks('TRUE', 'TRUE', 'Ramesh'));
  t.places.push(ticks('FALSE', ''), ticks('FALSE', 'FALSE'));
  const r = validateMelaSheet(t, { requireVerified: true });
  assert.deepEqual(r.errors, []);
  assert.equal(r.data.places.length, validateMelaSheet(cleanTabs(), { requireVerified: true }).data.places.length);
  // a row with real content and no id is still an error
  const bad = cleanTabs();
  bad.places.push(cols.map((c) => (c === 'name_en' ? 'New toilet' : c === 'category' ? 'toilet' : '')));
  assert.ok(validateMelaSheet(bad, {}).errors.some((e) => /id is empty/.test(e.msg)));
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
  assert.equal(normDate('2025/11/30'), '2025-11-30', "Google Sheets' yyyy/mm/dd format");
  assert.equal(normDate('2026/02/31'), null);
  assert.equal(normTime('7:00 PM'), '19:00');
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
test('menu: AI off -> no "Ask a question" row, and an old Ask button just shows the menu', () => {
  const snap = { ...snapshot(), qa_enabled: false };
  const m = ok(melaHandle(req({ kind: 'open', id: 'mela:open' }), snap));
  const ids = m.messages[0].sections[0].rows.map((r) => r.id);
  assert.ok(!ids.includes('mela:ask'), ids.join());
  assert.ok(!JSON.stringify(m).includes('History'));
  const old = ok(melaHandle(req({ kind: 'list', id: 'mela:ask' }), snap));
  assert.equal(old.messages[0].type, 'list');
  assert.equal(old.next_state, null);
  const unanswered = melaQaFinish(req({}), snap, { error: { message: 'llm disabled' } });
  assert.deepEqual(unanswered.messages[0].buttons.map((b) => b.id).filter((i) => i === 'mela:ask'), []);
});

test('menu: more than 10 rows -> "More services" holds the rest, nothing is dropped', () => {
  const tabs = cleanTabs();
  const cols = tabs.places[0];
  const extra = (id, cat) => { const row = cols.map(() => ''); row[cols.indexOf('id')] = id; row[cols.indexOf('category')] = cat;
    row[cols.indexOf('name_en')] = id + ' desk'; row[cols.indexOf('name_hi')] = id + ' केंद्र'; row[cols.indexOf('active')] = 'yes'; row[cols.indexOf('verified')] = 'yes'; return row; };
  tabs.places.push(extra('AC01', 'accommodation'), extra('TW01', 'toilet_water'), extra('LF01', 'lost_found'), extra('HD01', 'help_desk'));
  for (const qa of [true, false]) {
    const snap = { ...snapshot(tabs, { TH01: { lat: 25.69, lon: 85.17 } }), qa_enabled: qa };
    const m = ok(melaHandle(req({ kind: 'open', id: 'mela:open' }), snap));
    const ids = m.messages[0].sections[0].rows.map((r) => r.id);
    assert.equal(ids.length, 10, ids.join());
    assert.ok(ids.includes('mela:more'));
    assert.equal(ids.includes('mela:ask'), qa);
    const more = ok(melaHandle(req({ kind: 'list', id: 'mela:more' }), snap));
    const moreIds = more.messages[0].sections[0].rows.map((r) => r.id);
    assert.equal(moreIds[moreIds.length - 1], 'mela:open');
    const all = ids.concat(moreIds);
    for (const c of ['thana', 'health_centre', 'vet_camp', 'parking', 'ghat', 'accommodation', 'toilet_water', 'lost_found', 'help_desk']) {
      assert.ok(all.includes(`mela:cat:${c}`), `${c} reachable (qa=${qa})`);
    }
    assert.ok(all.includes('mela:today') && all.includes('mela:control') && all.includes('mela:near'));
  }
});

test('menu as the main menu: "File a Complaint" in its own section on the first screen, nothing pushed out of reach', () => {
  const others = [{ id: 'core:open:cmp', title_en: 'File a Complaint', title_hi: 'शिकायत दर्ज करें', description_en: 'Report a problem', description_hi: 'समस्या बताएँ' }];
  const tabs = cleanTabs();
  const cols = tabs.places[0];
  const extra = (id, cat) => { const row = cols.map(() => ''); row[cols.indexOf('id')] = id; row[cols.indexOf('category')] = cat;
    row[cols.indexOf('name_en')] = id + ' desk'; row[cols.indexOf('name_hi')] = id + ' केंद्र'; row[cols.indexOf('active')] = 'yes'; row[cols.indexOf('verified')] = 'yes'; return row; };
  for (const crowded of [false, true]) {
    const t = clone(tabs);
    if (crowded) t.places.push(extra('AC01', 'accommodation'), extra('TW01', 'toilet_water'), extra('LF01', 'lost_found'), extra('HD01', 'help_desk'));
    const snap = { ...snapshot(t, { TH01: { lat: 25.69, lon: 85.17 } }), qa_enabled: false };
    for (const lang of ['en', 'hi']) {
      const m = ok(melaHandle(req({ kind: 'open', id: 'mela:open' }, { lang, other_services: others }), snap));
      const [mela, district] = m.messages[0].sections;
      assert.deepEqual(district.rows.map((r) => [r.id, r.title]), [['core:open:cmp', lang === 'hi' ? 'शिकायत दर्ज करें' : 'File a Complaint']]);
      assert.equal(mela.rows.length + district.rows.length <= 10, true, 'WhatsApp lists hold 10 rows');
      if (crowded) {
        assert.ok(mela.rows.some((r) => r.id === 'mela:more'));
        const more = ok(melaHandle(req({ kind: 'list', id: 'mela:more' }, { lang, other_services: others }), snap));
        const all = mela.rows.concat(more.messages[0].sections[0].rows).map((r) => r.id);
        for (const c of ['thana', 'health_centre', 'vet_camp', 'parking', 'ghat', 'accommodation', 'toilet_water', 'lost_found', 'help_desk']) {
          assert.ok(all.includes(`mela:cat:${c}`), `${c} still reachable`);
        }
      }
    }
  }
  // opened on its own (not as the main menu): one section, as before
  assert.equal(ok(melaHandle(req({ kind: 'open', id: 'mela:open' }), snapshot())).messages[0].sections.length, 1);
});

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
  assert.equal(res.log.detail, 'gps:<250m', 'distance bucket logged, never the location');
  const far = ok(melaHandle(req({ kind: 'location', lat: 25.6, lon: 85.1 }, { state: 'mela.await_location', context: { near_cat: 'thana' } }), s));
  assert.match(body(far), /outside the Mela area/); assert.equal(far.log.detail, 'gps:outside');
  const land = ok(melaHandle(req({ kind: 'text', text: 'kali ghat' }, { state: 'mela.await_location', context: { near_cat: 'thana' } }), s));
  assert.match(body(land), /Nearest police station/); assert.match(land.log.detail, /^landmark:/);
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
  assert.deepEqual(detectTopic('bhai paas me police chowki kahan hai'), { near: true, topic: 'thana', hits: ['near', 'thana'] });
  assert.deepEqual(detectTopic('police station kahan hai'), { near: false, topic: 'thana', hits: ['thana'] }, '"where" is not "near me"');
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
  assert.equal(r.model, 'claude-haiku-5-5');
  assert.match(r.system[0].text, /Harihar Kshetra/);
  assert.deepEqual(r.system[0].cache_control, { type: 'ephemeral' }, 'the reference is prompt-cached');
  assert.deepEqual(r.output_config.format.schema.required, ['answerable', 'answer', 'place_ids']);
  for (const k of ['temperature', 'top_p', 'top_k']) assert.ok(!(k in r), `${k} must not be sent`);
  assert.equal(r.output_config.effort, 'low'); assert.ok(r.max_tokens >= 2048);
  const resp = (d) => ({ stop_reason: 'end_turn', usage: { input_tokens: 900, output_tokens: 80 },
    content: [{ type: 'thinking', thinking: '', signature: 's' }, { type: 'text', text: JSON.stringify(d) }] });
  const good = ok(melaQaFinish(req({}), s, resp({ answerable: true, answer: 'It is at Harihar Kshetra.' })));
  assert.equal(body(good), 'It is at Harihar Kshetra.'); assert.equal(good.log.llm_tokens, 980); assert.equal(good.done, true);
  const bad = ok(melaQaFinish(req({}, { lang: 'hi' }), s, resp({ answerable: false, answer: '' })));
  assert.match(body(bad), /जानकारी मेरे पास नहीं/); assert.match(body(bad), /06158-221084/);
  assert.equal(bad.log.unanswered_reason, 'qa_no_answer'); assert.equal(bad.log.llm_tokens, 980);
  const err = ok(melaQaFinish(req({}), s, { error: { message: 'timeout' } }));
  assert.equal(err.log.resolved, false); assert.equal(err.log.unanswered_reason, 'qa_error');
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

// --- toilets -------------------------------------------------------------------------
function withToilets(cat = 'toilet') {
  const tabs = cleanTabs();
  const cols = tabs.places[0];
  const row = (id, name, lat, lon) => { const r = cols.map(() => ''); r[cols.indexOf('id')] = id; r[cols.indexOf('category')] = cat;
    r[cols.indexOf('name_en')] = name; r[cols.indexOf('name_hi')] = name + ' शौचालय'; r[cols.indexOf('lat')] = lat; r[cols.indexOf('lon')] = lon;
    r[cols.indexOf('active')] = 'yes'; r[cols.indexOf('verified')] = 'yes'; return r; };
  tabs.places.push(row('TL01', 'Gate 1 toilet block', '25.6930', '85.1700'), row('TL02', 'Kali Ghat toilets', '25.6827', '85.1907'),
    row('TL03', 'Cattle market toilets', '25.6983', '85.1661'), row('TL04', 'Main pandal toilets', '25.6950', '85.1786'));
  return snapshot(tabs);
}

test('toilets: own menu row after vet camps, in Near me, and listed with walking directions', () => {
  const snap = { ...withToilets(), qa_enabled: false };
  const menu = ok(melaHandle(req({ kind: 'open', id: 'mela:open' }), snap));
  const ids = menu.messages[0].sections[0].rows.map((r) => r.id);
  assert.equal(ids[ids.indexOf('mela:cat:vet_camp') + 1], 'mela:cat:toilet', ids.join());
  assert.match(JSON.stringify(menu), /🚻 Toilets/);
  const hi = ok(melaHandle(req({ kind: 'open', id: 'mela:open' }, { lang: 'hi' }), snap));
  assert.match(JSON.stringify(hi), /🚻 शौचालय/);
  const near = ok(melaHandle(req({ kind: 'list', id: 'mela:near' }), snap));
  assert.equal(near.messages[0].type, 'location_request', 'Near me asks for the location straight away');
  const all = ok(melaHandle(req({ kind: 'location', lat: 25.6931, lon: 85.1702 }, { state: 'mela.await_location', context: {} }), snap));
  assert.match(all.messages[0].body, /🚻 \*Nearest toilet\*/, 'toilets are among the services');
  const list = ok(melaHandle(req({ kind: 'text', text: 'toilet kahan hai' }), snap));
  const text = list.messages.map((m) => m.body || '').join('\n');
  assert.match(text, /Gate 1 toilet block/);
  assert.match(text, /🧭 https:\/\/www\.google\.com\/maps\/dir\/\?api=1&destination=25\.693,85\.17&travelmode=walking/);
  const hiText = ok(melaHandle(req({ kind: 'text', text: 'शौचालय कहाँ है' }, { lang: 'hi' }), snap));
  assert.match(hiText.messages.map((m) => m.body || '').join('\n'), /शौचालय/);
});

test('toilets: "nearest toilet" asks for the location, then gives the 3 nearest with a map pin', () => {
  const snap = withToilets();
  const ask = ok(melaHandle(req({ kind: 'text', text: 'nearest toilet' }), snap));
  assert.equal(ask.messages[0].type, 'location_request');
  assert.deepEqual(ask.context, { near_cat: 'toilet' });
  const res = ok(melaHandle(req({ kind: 'location', lat: 25.6931, lon: 85.1702 }, { state: 'mela.await_location', context: { near_cat: 'toilet' } }), snap));
  const body = res.messages[0].body;
  assert.match(body, /Nearest toilet/);
  assert.ok(body.indexOf('Gate 1 toilet block') < body.indexOf('Main pandal toilets'), 'closest first');
  assert.equal((body.match(/🧭 https:/g) || []).length, 3, 'three nearest, each with a directions link');
  const pin = res.messages.find((m) => m.type === 'location');
  assert.equal(pin.name, 'Gate 1 toilet block');
  assert.equal(res.log.subtype, 'near_toilet');
  // a location shared without asking first: the nearest of every service, toilets included
  const any = ok(melaHandle(req({ kind: 'location', lat: 25.6931, lon: 85.1702 }), withToilets()));
  assert.match(any.messages[0].body, /Nearest toilet/);
});

test('near me: one location share, then the nearest ONE of every service, no category question', () => {
  const coords = { TH01: { lat: 25.6930, lon: 85.1760 }, TH03: { lat: 25.6922, lon: 85.1752 }, HC01: { lat: 25.6935, lon: 85.1745 },
    GH01: { lat: 25.6925, lon: 85.1755 }, GH02: { lat: 25.7100, lon: 85.2000 } };
  const s = snapshot(undefined, coords);
  for (const lang of ['en', 'hi']) {
    // the menu row and typed "near me" both go straight to the location request
    for (const input of [{ kind: 'list', id: 'mela:near' }, { kind: 'text', text: lang === 'hi' ? 'मेरे पास' : 'near me' }]) {
      const ask = ok(melaHandle(req(input, { lang }), s));
      assert.equal(ask.messages.length, 1); assert.equal(ask.messages[0].type, 'location_request', JSON.stringify(input));
      assert.equal(ask.next_state, 'mela.await_location'); assert.deepEqual(ask.context, {});
    }
  }
  const res = ok(melaHandle(req({ kind: 'location', lat: 25.6921, lon: 85.1751 }, { state: 'mela.await_location', context: {} }), s));
  const b = body(res);
  // one per category that has pins, in menu order, the closest of each
  const heads = [...b.matchAll(/\*Nearest ([^*]+)\*/g)].map((m) => m[1]);
  assert.deepEqual(heads, ['police station', 'health centre', 'ghat'], b);
  assert.match(b, /\*Theater Thana\* – ≈10 m/, 'closest police station, not the second one');
  assert.doesNotMatch(b, /Nakash Thana/, 'only one per service');
  assert.equal((b.match(/🧭 https:/g) || []).length, 3, 'a walking link for each');
  assert.deepEqual(res.messages.map((m) => m.type), ['text', 'buttons'], 'no map pin: 2 WhatsApp messages, not 3');
  assert.equal(res.log.subtype, 'near_all'); assert.equal(res.log.detail, 'gps:<250m');
  // sheet float noise does not reach the link
  const noisy = snapshot(undefined, { TH03: { lat: 25.6917529999999, lon: 85.1852869999999 } });
  const n = ok(melaHandle(req({ kind: 'location', lat: 25.6921, lon: 85.1751 }, { state: 'mela.await_location', context: { near_cat: 'thana' } }), noisy));
  assert.match(body(n), /destination=25\.691753,85\.185287&/);
  assert.doesNotMatch(JSON.stringify(res), /origin=|25\.6921/, 'the citizen location never leaves');
  // a landmark instead of GPS: the same one-of-each answer
  const lm = ok(melaHandle(req({ kind: 'text', text: 'Kali Ghat' }, { state: 'mela.await_location', context: {} }), s));
  assert.equal(lm.log.subtype, 'near_all'); assert.match(lm.log.detail, /^landmark:/);
  // outside the Mela area: the menu with a note, no guesses
  const far = ok(melaHandle(req({ kind: 'location', lat: 25.6, lon: 85.1 }, { state: 'mela.await_location', context: {} }), s));
  assert.match(far.messages[0].body, /outside the Mela area/); assert.equal(far.messages[0].type, 'list');
  assert.equal(far.log.detail, 'gps:outside');
  // a category's own 📍 Nearest button still gives the 3 nearest of that one kind
  const one = ok(melaHandle(req({ kind: 'location', lat: 25.6921, lon: 85.1751 }, { state: 'mela.await_location', context: { near_cat: 'thana' } }), s));
  assert.match(body(one), /1\. \*Theater Thana\*[\s\S]*2\. \*Nakash Thana\*/); assert.equal(one.messages[1].type, 'location');
});

test('toilets: a sheet that still uses the older toilet_water category is found by a toilet question', () => {
  const snap = withToilets('toilet_water');
  const list = ok(melaHandle(req({ kind: 'text', text: 'washroom' }), snap));
  assert.match(list.messages.map((m) => m.body || '').join('\n'), /Gate 1 toilet block/);
});

// --- places to visit + FAQ (optional sheet tabs) ----------------------------------------
const ATT_HEAD = ['id', 'type', 'name_en', 'name_hi', 'about_en', 'about_hi', 'location_en', 'location_hi', 'lat', 'lon',
  'hours', 'keywords', 'active', 'verified', 'updated_by'];
const FAQ_HEAD = ['id', 'question_en', 'question_hi', 'answer_en', 'answer_hi', 'active', 'verified', 'updated_by'];
function visitTabs(extraAtt = [], extraFaq = []) {
  const t = cleanTabs();
  t.attractions = [ATT_HEAD,
    ['A01', 'animal_bazaar', 'Ghoda Bazaar', 'घोड़ा बाज़ार', 'Horses of every breed are bought and sold here.', 'यहाँ हर नस्ल के घोड़े ख़रीदे-बेचे जाते हैं।',
      'North of Hariharnath Temple', 'हरिहरनाथ मंदिर के उत्तर', '25.6951', '85.1782', '6 am – 6 pm', 'horse, घोड़ा, horses', 'TRUE', 'TRUE', 'x'],
    ['A02', 'bazaar', 'Meena Bazaar', 'मीना बाज़ार', 'Clothes, bangles, household goods.', 'कपड़े, चूड़ियाँ, घरेलू सामान।', 'Main road', 'मुख्य सड़क',
      '25.6930', '85.1760', '10 am – 10 pm', 'bangles, chudi', 'TRUE', 'TRUE', 'x'],
    ['A03', 'food_court', 'Food Court', 'फ़ूड कोर्ट', 'Bihari food: litti chokha, malpua.', 'बिहारी व्यंजन: लिट्टी चोखा, मालपुआ।', 'Near Gate 2', 'गेट 2 के पास',
      '', '', '', 'litti, khana', 'TRUE', 'TRUE', 'x'],
    ...extraAtt];
  t.faq = [FAQ_HEAD,
    ['Q01', 'Is there an entry fee?', 'क्या प्रवेश शुल्क है?', 'No, entry to the Mela is free. For help call 06158-221084.', 'नहीं, मेले में प्रवेश निःशुल्क है।', 'TRUE', 'TRUE', 'x'],
    ...extraFaq];
  return t;
}

test('sheet: attractions and faq tabs are optional, validated and counted', () => {
  const without = validateMelaSheet(cleanTabs(), {});
  assert.deepEqual([without.counts.attractions, without.counts.faq], [0, 0]);
  const r = validateMelaSheet(visitTabs(), {});
  assert.deepEqual(r.errors, []);
  assert.deepEqual([r.counts.attractions, r.counts.faq], [3, 1]);
  const a = r.data.attractions[0];
  assert.deepEqual([a.type, a.lat, a.lon, a.keywords], ['animal_bazaar', 25.6951, 85.1782, ['horse', 'घोड़ा', 'horses']]);
  assert.ok(r.warnings.some((w) => w.tab === 'attractions' && /no lat\/lon/.test(w.msg)), 'food court without a pin is a warning');
  assert.deepEqual(r.data.text_numbers, ['06158-221084'], 'a number inside an FAQ answer is registered for the phone guard');
  const bad = validateMelaSheet(visitTabs([['A01', 'Bazaar Area!', '', '', '', '', '', '', '85.1', '25.6', '', '', 'TRUE', 'TRUE', 'x']],
    [['Q02', 'Only a question?', '', '', '', 'TRUE', 'TRUE', 'x']]), {});
  const msgs = bad.errors.map((e) => `${e.tab}: ${e.msg}`).join('\n');
  for (const want of [/attractions: duplicate id "A01"/, /attractions: type "Bazaar Area!"/, /attractions: name_en or name_hi/, /attractions: lat\/lon/, /faq: answer_en or answer_hi/]) {
    assert.match(msgs, want);
  }
  const missingCol = visitTabs();
  missingCol.faq[0] = missingCol.faq[0].filter((c) => c !== 'answer_hi');
  assert.match(validateMelaSheet(missingCol, {}).errors[0].msg, /missing column\(s\): answer_hi/);
  const unverified = visitTabs();
  unverified.attractions[1][ATT_HEAD.indexOf('verified')] = '';
  assert.equal(validateMelaSheet(unverified, { requireVerified: true }).counts.attractions, 2, 'unverified rows stay out in production');
});

test('places to visit: menu row, grouped list, one-message cards with walking directions', () => {
  const s = snapshot(visitTabs());
  const menu = ok(melaHandle(req({ kind: 'open', id: 'mela:open' }), s));
  assert.ok(menu.messages[0].sections[0].rows.some((r) => r.id === 'mela:visit'));
  assert.ok(!ok(melaHandle(req({ kind: 'open', id: 'mela:open' }), snapshot())).messages[0].sections[0].rows.some((r) => r.id === 'mela:visit'),
    'no row without data');
  const v = ok(melaHandle(req({ kind: 'list', id: 'mela:visit' }), s));
  assert.equal(v.messages.length, 1, 'fits in one message');
  assert.match(body(v), /Animal markets[\s\S]*Ghoda Bazaar[\s\S]*Bazaars & shopping[\s\S]*Meena Bazaar[\s\S]*Food courts/);
  assert.match(body(v), /🧭 https:\/\/www\.google\.com\/maps\/dir\/\?api=1&destination=25\.6951,85\.1782&travelmode=walking/);
  const hi = ok(melaHandle(req({ kind: 'list', id: 'mela:visit' }, { lang: 'hi' }), s));
  assert.match(body(hi), /घोड़ा बाज़ार/); assert.match(body(hi), /घूमने की जगहें/);
  // many places -> a list of types first, then one type
  const many = visitTabs(Array.from({ length: 6 }, (_, i) => [`B0${i}`, 'craft', `Craft stall ${i}`, '', 'Madhubani paintings', '', '', '', '', '', '', '', 'TRUE', 'TRUE', 'x']));
  const sm = snapshot(many);
  const types = ok(melaHandle(req({ kind: 'list', id: 'mela:visit' }), sm));
  assert.equal(types.messages[0].type, 'list');
  assert.deepEqual(types.messages[0].sections[0].rows.map((r) => r.id),
    ['mela:visit:animal_bazaar', 'mela:visit:bazaar', 'mela:visit:food_court', 'mela:visit:craft', 'mela:open']);
  const craft = ok(melaHandle(req({ kind: 'list', id: 'mela:visit:craft' }), sm));
  assert.match(body(craft), /Art & craft/); assert.ok(!/Ghoda/.test(body(craft)));
  assert.deepEqual(craft.messages.at(-1).buttons.map((b) => b.id), ['mela:visit', 'core:menu']);
});

test('places to visit: free text finds them in Hindi, Hinglish and English - without the AI', () => {
  const s = { ...snapshot(visitTabs()), qa_enabled: false };
  const card = (text, lang = 'en') => ok(melaHandle(req({ kind: 'text', text }, { lang }), s));
  assert.match(body(card('ghoda kharidna hai')), /Ghoda Bazaar/, 'buy + horse word beats the vet-camp topic');
  assert.match(body(card('where can i buy horses')), /Ghoda Bazaar/);
  assert.match(body(card('घोड़ा खरीदना है', 'hi')), /घोड़ा बाज़ार/);
  assert.match(body(card('meena bazaar kahan hai')), /Meena Bazaar[\s\S]*Clothes/);
  assert.match(body(card('litti kahan milega')), /Food Court/);
  assert.match(body(card('mela me ghumne ki jagah')), /Places to visit/);
  assert.match(body(card('haathi ka doctor')), /Veterinary/, 'an animal word alone is still a vet question');
  assert.match(body(card('Ghora Bazar thana')), /Ghora Bazar/, 'a facility named "... Bazar" stays that facility');
  assert.doesNotMatch(body(card('Ghora Bazar thana')), /Places to visit/);
  assert.equal(matchAttraction(s, 'kuch bhi'), null);
  const off = card('what is the history of this fair?');
  assert.equal(off.messages[0].type, 'list', 'AI off: menu, not a dead end');
  assert.match(body(off), /couldn't understand/); assert.equal(off.log.unanswered_reason, 'llm_disabled');
});

test('AI answers: one compact cached reference from the whole sheet, map links added by the bot', () => {
  const s = snapshot(visitTabs());
  const hist = '# Title\n\n> editor note\n\n## Overview\nSonpur Mela is held at Harihar Kshetra.\n\nSource: [x](https://example.org)\n';
  const r = melaQaRequest('  where   can I\n buy a horse?  ', hist, s, null, '2025-11-23');
  const sys = r.system[0].text;
  assert.match(sys, /Harihar Kshetra/); assert.doesNotMatch(sys, /editor note|example\.org|Source:/);
  assert.match(sys, /\[A01\] Ghoda Bazaar \/ घोड़ा बाज़ार \(Animal markets\): Horses of every breed/);
  assert.match(sys, /\[TH01\] police station: Nakash Thana/);
  assert.match(sys, /Q: Is there an entry fee\? \/ क्या प्रवेश शुल्क है\?\nA: No, entry to the Mela is free/);
  assert.match(sys, /today is 2025-11-23/); assert.match(sys, /2025-11-23 .*Monali Thakur/);
  assert.doesNotMatch(sys, /2025-11-29/, 'programme: today and the next two days only');
  assert.doesNotMatch(sys, /7090950940/, 'no duty phones in the reference');
  assert.equal(r.messages[0].content, 'where can I buy a horse?', 'question tidied');
  assert.ok(sys.length < 20000, `reference stays small: ${sys.length}`);
  // same data, other question -> byte-identical system prompt (cache hit)
  assert.equal(melaQaRequest('other?', hist, s, null, '2025-11-23').system[0].text, sys);
  // a huge sheet is trimmed to the lines that share words with the question, and not cached
  const big = { ...s, faq: Array.from({ length: 900 }, (_, i) => ({ id: `F${i}`, question_en: `Question number ${i} about tickets`, answer_en: 'x'.repeat(80) }))
    .concat([{ id: 'FX', question_en: 'Is there a camel race?', answer_en: 'Yes, on 25 November.' }]) };
  const t = qaReference('camel race kab hai', hist, big, '2025-11-23');
  assert.equal(t.trimmed, true); assert.match(t.text, /camel race/); assert.ok(t.text.length <= 61000);
  assert.ok(!('cache_control' in melaQaRequest('camel race kab hai', hist, big, null, '2025-11-23').system[0]));

  const resp = (d) => ({ stop_reason: 'end_turn', usage: { input_tokens: 40, cache_read_input_tokens: 5000, output_tokens: 90 },
    content: [{ type: 'text', text: JSON.stringify(d) }] });
  const a = ok(melaQaFinish(req({}), s, resp({ answerable: true, answer: 'Go to *Ghoda Bazaar*, north of the temple.', place_ids: ['A01', 'A03', 'NOPE', 'A01'] })));
  assert.equal(a.messages.length, 1);
  assert.match(body(a), /^Go to \*Ghoda Bazaar\*, north of the temple\.\n\n🐎 Ghoda Bazaar – 🧭 https:\/\/www\.google\.com\/maps\/dir\/\?api=1&destination=25\.6951,85\.1782&travelmode=walking$/,
    'only places with a pin get a link; unknown ids and duplicates ignored');
  assert.equal(a.log.llm_tokens, 40 + 500 + 90, 'cache reads counted at a tenth');
  const hiA = ok(melaQaFinish(req({}, { lang: 'hi' }), s, resp({ answerable: true, answer: 'घोड़ा बाज़ार जाइए।', place_ids: ['TH01'] })));
  assert.doesNotMatch(body(hiA), /🧭/, 'a facility without coordinates gets no link');
});
