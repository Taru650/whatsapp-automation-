// Unit tests for the complaint-registration service (n8n/src/services/complaint.js).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { complaintHandle, complaintReceiptMessage, haversineM } = require('../../n8n/src/services/complaint.js');
const { buildStatusNotification } = require('../../n8n/src/services/complaint_notify.js');
const { validateServiceOutput } = require('../../n8n/src/core/contract.js');
const { renderMessage } = require('../../n8n/src/core/render.js');

const req = (input, over = {}) => ({ wa_hash: 'h', lang: 'en', state: null, context: {}, is_admin: false,
  now_ist: '2026-11-23 15:10', now_iso: '2026-11-23T09:40:00Z', input: { id: null, media_id: null, mime: null, text: null, lat: null, lon: null, ...input }, ...over });
const snapFixture = (over = {}) => ({
  categories: [
    { category_key: 'water_supply', label_en: 'Water supply', label_hi: 'पानी की समस्या' },
    { category_key: 'veterinary_animal', label_en: 'Veterinary / animal & bird care', label_hi: 'पशु व पक्षी चिकित्सा' },
  ],
  my_complaints: [],
  geofence: { enabled: 'false', center_lat: null, center_lon: null, radius_m: 500 },
  ...over,
});
const ok = (o) => { assert.deepEqual(validateServiceOutput(o, 'cmp'), []); for (const m of o.messages) renderMessage(m, '91x'); return o; };
const body = (o, i = 0) => o.messages[i].body;

test('complaint: open menu offers new vs mine', () => {
  const o = ok(complaintHandle(req({ id: 'cmp:open' }), snapFixture()));
  assert.match(body(o), /File a new complaint/);
  assert.deepEqual(o.messages[0].buttons.map((b) => b.id), ['cmp:new', 'cmp:mine', 'core:menu']);
});

test('complaint: category menu paginates at 9 rows and keeps every id prefixed cmp:', () => {
  const many = Array.from({ length: 11 }, (_, i) => ({ category_key: `c${i}`, label_en: `Cat ${i}` }));
  const o = ok(complaintHandle(req({ id: 'cmp:new' }), snapFixture({ categories: many })));
  const rows = o.messages[0].sections[0].rows;
  assert.equal(rows.length, 10, '9 categories + one "More" row');
  assert.equal(rows[9].id, 'cmp:catpage:1');
  const page2 = ok(complaintHandle(req({ id: 'cmp:catpage:1' }), snapFixture({ categories: many })));
  assert.equal(page2.messages[0].sections[0].rows.length, 2, 'the remaining 2 categories, no further More row');
});

test('complaint: registration happy path end to end', () => {
  const snap = snapFixture();
  let o = ok(complaintHandle(req({ id: 'cmp:cat:water_supply' }), snap));
  assert.equal(o.next_state, 'cmp.describe');
  assert.deepEqual(o.context, { category_key: 'water_supply', category_label: 'Water supply' });

  o = ok(complaintHandle(req({ kind: 'text', text: 'No water since morning' }, { state: 'cmp.describe', context: o.context }), snap));
  assert.equal(o.next_state, 'cmp.evidence');
  assert.equal(o.context.description, 'No water since morning');

  // a photo is required - typing done with none yet re-prompts and stays put
  o = ok(complaintHandle(req({ kind: 'text', text: 'done' }, { state: 'cmp.evidence', context: o.context }), snap));
  assert.equal(o.next_state, 'cmp.evidence');
  assert.match(body(o), /at least one photo/);

  const withPhoto = { ...o.context };
  o = ok(complaintHandle(req({ kind: 'image', media_path: 'h/1.jpg', media_mime: 'image/jpeg', media_kind: 'photo', media_sha256: 'x' },
    { state: 'cmp.evidence', context: withPhoto }), snap));
  assert.equal(o.next_state, 'cmp.evidence');
  assert.equal(o.context.evidence.length, 1);
  assert.deepEqual(o.messages[0].buttons.map((b) => b.id), ['cmp:evidence:done']);

  o = ok(complaintHandle(req({ id: 'cmp:evidence:done' }, { state: 'cmp.evidence', context: o.context }), snap));
  assert.equal(o.next_state, 'cmp.location');
  assert.equal(o.messages[0].type, 'location_request');

  o = ok(complaintHandle(req({ kind: 'location', lat: 25.69, lon: 85.17 }, { state: 'cmp.location', context: o.context }), snap));
  assert.equal(o.next_state, 'cmp.confirm');
  assert.equal(o.context.lat, 25.69);
  assert.deepEqual(o.messages[0].buttons.map((b) => b.id), ['cmp:confirm', 'cmp:edit', 'core:menu']);

  o = ok(complaintHandle(req({ id: 'cmp:confirm' }, { state: 'cmp.confirm', context: o.context }), snap));
  assert.equal(o.done, true);
  assert.equal(o.messages.length, 0, 'no messages yet - the real receipt needs the complaint_id from apply_effects');
  assert.equal(o.effects[0].type, 'create_complaint');
  assert.deepEqual(o.effects[0], { type: 'create_complaint', category_key: 'water_supply', description: 'No water since morning',
    lang: 'en', lat: 25.69, lon: 85.17, evidence: [{ path: 'h/1.jpg', mime: 'image/jpeg', kind: 'photo', sha256: 'x' }] });
});

test('complaint: evidence cap at 5, and a media download error re-prompts without advancing', () => {
  const snap = snapFixture();
  const five = Array.from({ length: 5 }, (_, i) => ({ path: `h/${i}.jpg`, mime: 'image/jpeg', kind: 'photo' }));
  const ctx = { category_key: 'water_supply', category_label: 'Water supply', description: 'x', evidence: five };
  let o = ok(complaintHandle(req({ kind: 'image', media_path: 'h/6.jpg', media_mime: 'image/jpeg', media_kind: 'photo' }, { state: 'cmp.evidence', context: ctx }), snap));
  assert.equal(o.context.evidence.length, 5, 'a 6th photo is not added once the cap is reached');
  assert.match(body(o), /maximum of 5/);

  o = ok(complaintHandle(req({ kind: 'image', media_error: 'too_large' }, { state: 'cmp.evidence', context: { ...ctx, evidence: [] } }), snap));
  assert.equal(o.next_state, 'cmp.evidence');
  assert.match(body(o), /too large/);
  assert.deepEqual(o.context.evidence, [], 'a rejected upload is never added to the evidence list');
});

test('complaint: geofence rejects outside the radius, accepts inside it, and is a no-op when disabled', () => {
  const ctx = { category_key: 'water_supply', category_label: 'Water supply', description: 'x', evidence: [{ path: 'h/1.jpg' }] };
  const geoOn = snapFixture({ geofence: { enabled: 'true', center_lat: 25.69, center_lon: 85.17, radius_m: 500 } });

  // ~1.1km away (roughly 0.01 degrees latitude ~ 1.1km) - outside a 500m radius
  let o = ok(complaintHandle(req({ kind: 'location', lat: 25.70, lon: 85.17 }, { state: 'cmp.location', context: ctx }), geoOn));
  assert.equal(o.next_state, 'cmp.location', 'outside the geofence: no complaint, stays put');
  assert.match(body(o), /inside the Mela ground/);

  o = ok(complaintHandle(req({ kind: 'location', lat: 25.6905, lon: 85.1705 }, { state: 'cmp.location', context: ctx }), geoOn));
  assert.equal(o.next_state, 'cmp.confirm', 'inside the geofence: proceeds to confirm');

  const geoOff = snapFixture();
  o = ok(complaintHandle(req({ kind: 'location', lat: 1, lon: 1 }, { state: 'cmp.location', context: ctx }), geoOff));
  assert.equal(o.next_state, 'cmp.confirm', 'geofence disabled: any location is accepted');
});

test('complaint: edit returns to describe keeping the category, confirm with a stale context falls back to the menu', () => {
  const snap = snapFixture();
  const ctx = { category_key: 'water_supply', category_label: 'Water supply', description: 'old text', evidence: [{ path: 'x' }], lat: 1, lon: 1 };
  let o = ok(complaintHandle(req({ id: 'cmp:edit' }, { state: 'cmp.confirm', context: ctx }), snap));
  assert.equal(o.next_state, 'cmp.describe');
  assert.deepEqual(o.context, { category_key: 'water_supply', category_label: 'Water supply' });

  o = ok(complaintHandle(req({ id: 'cmp:confirm' }, { state: 'cmp.confirm', context: {} }), snap));
  assert.equal(o.done, false);
  assert.match(body(o), /File a new complaint/, 'no effects fire without a complete context');
});

test('complaint: status check by id, restricted to the citizen\'s own number', () => {
  const snap = snapFixture({ my_complaints: [{ complaint_id: 'SCB-2026-C00001', category_key: 'water_supply', status: 'in_progress', created_at: '2026-11-20 10:00', updated_at: '2026-11-21 09:00' }] });
  let o = ok(complaintHandle(req({ kind: 'text', text: 'SCB-2026-C00001' }), snap));
  assert.match(body(o), /In progress/);
  o = ok(complaintHandle(req({ kind: 'text', text: 'scb-2026-c00001' }), snap));
  assert.match(body(o), /In progress/, 'case-insensitive');
  o = ok(complaintHandle(req({ kind: 'text', text: 'SCB-2026-C99999' }), snap));
  assert.match(body(o), /couldn't find/);
});

test('complaint: "my complaints" lists everything, or says there is nothing yet', () => {
  let o = ok(complaintHandle(req({ kind: 'text', text: 'मेरी शिकायत' }), snapFixture()));
  assert.match(body(o), /not filed any complaints/);
  const snap = snapFixture({ my_complaints: [{ complaint_id: 'SCB-2026-C00001', status: 'closed', updated_at: '2026-11-21 09:00' }] });
  o = ok(complaintHandle(req({ id: 'cmp:mine' }), snap));
  assert.match(body(o), /SCB-2026-C00001/);
});

test('complaint: stale/unknown ids and unrelated input fall back to the open menu', () => {
  assert.match(body(ok(complaintHandle(req({ id: 'cmp:does-not-exist' }), snapFixture()))), /File a new complaint/);
  assert.match(body(ok(complaintHandle(req({ kind: 'text', text: 'hello there' }), snapFixture()))), /File a new complaint/);
});

test('complaintReceiptMessage: real id vs a failed registration', () => {
  const o1 = ok(complaintReceiptMessage(req({}), 'SCB-2026-C00042'));
  assert.match(body(o1), /SCB-2026-C00042/);
  assert.equal(o1.log.subtype, 'registered');
  const o2 = ok(complaintReceiptMessage(req({}), null));
  assert.match(body(o2), /could not be registered/);
  assert.equal(o2.log.resolved, false);
});

test('haversineM: zero at the same point, realistic over ~1 degree latitude', () => {
  assert.equal(haversineM(25.69, 85.17, 25.69, 85.17), 0);
  const d = haversineM(25.0, 85.0, 26.0, 85.0);
  assert.ok(d > 110000 && d < 112000, String(d));
});

test('buildStatusNotification: status label and an optional remark, both languages', () => {
  const en = buildStatusNotification({ complaint_id: 'SCB-2026-C00001', status: 'resolved', remark: 'Pipe fixed' }, 'en');
  assert.match(en[0].body, /SCB-2026-C00001/);
  assert.match(en[0].body, /Resolved/);
  assert.match(en[0].body, /Pipe fixed/);
  const hi = buildStatusNotification({ complaint_id: 'SCB-2026-C00001', status: 'closed' }, 'hi');
  assert.match(hi[0].body, /बंद/);
  assert.doesNotMatch(hi[0].body, /Note:/);
});
