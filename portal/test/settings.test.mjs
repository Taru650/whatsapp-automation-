import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { setup, login, post, adminPool } from './helpers.mjs';
import { validateGeofence } from '../src/routes/settings.js';

const t = setup();
const admin = adminPool();
let s;
before(async () => {
  await t.ready;
  const a = await t.user('admin', 'district_admin');
  s = (await login(t.app, a.username)).agent;
});
after(async () => {
  await t.pool.query(`update grievance.settings set value = 'false' where key = 'geofence_enabled'`);
  await admin.end();
  await t.cleanup();
});

// What the WhatsApp flow reads on its next turn (portal_rw cannot call svc_complaint itself).
const whatWhatsAppSees = async () => (await admin.query(`select svc_complaint.snapshot('nobody')->'geofence' as g`)).rows[0].g;

test('saving the geofence form changes exactly what the WhatsApp flow reads next', async () => {
  const r = await post(s, '/portal/settings/geofence', { enabled: 'on', lat: '25.6920', lon: '85.1750', radius: '300' });
  assert.equal(r.status, 302);
  assert.deepEqual(await whatWhatsAppSees(), { enabled: true, center_lat: 25.692, center_lon: 85.175, radius_m: 300 });
  const page = await s.get('/portal/settings/geofence');
  assert.match(page.text, /Geofence on: complaints only from within 300 m/);

  await post(s, '/portal/settings/geofence', { lat: '25.6920', lon: '85.1750', radius: '300' });
  assert.equal((await whatWhatsAppSees()).enabled, false, 'an unticked switch turns it off');
  const audit = await t.pool.query(`select count(*)::int as n from grievance.portal_audit where action = 'geofence'`);
  assert.ok(audit.rows[0].n >= 2);
});

test('bad input is refused and nothing is saved', async () => {
  const before = await whatWhatsAppSees();
  for (const form of [
    { enabled: 'on', lat: '', lon: '', radius: '500' }, // on without a centre
    { lat: '85.17', lon: '25.69', radius: '500' }, // lat/lon swapped
    { lat: '25.69', lon: '', radius: '500' },
    { lat: '25.69', lon: '85.17', radius: '10' },
    { lat: '25.69', lon: '85.17', radius: 'abc' },
  ]) {
    const r = await post(s, '/portal/settings/geofence', form);
    assert.equal(r.status, 400, JSON.stringify(form));
  }
  assert.deepEqual(await whatWhatsAppSees(), before);
});

test('validateGeofence', () => {
  assert.deepEqual(validateGeofence({ radius: '500' }).value, { enabled: false, lat: null, lon: null, radius: 500 });
  assert.match(validateGeofence({ enabled: 'on', radius: '500' }).error, /centre point/);
  assert.match(validateGeofence({ lat: '40', lon: '85', radius: '500' }).error, /Latitude/);
});
