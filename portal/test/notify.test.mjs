// M8: every portal status change queues exactly one WhatsApp update for the
// citizen, in the same transaction, and the complaint page shows whether it
// was delivered. (Sending itself is n8n's core-11-notify-poll: flow tests.)
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { setup, login, post, tokenOf } from './helpers.mjs';

const t = setup();
const u = {};
let s;
before(async () => {
  await t.ready;
  u.admin = await t.user('admin', 'district_admin');
  u.head = await t.user('whead', 'dept_head', 'phed');
  u.officer = await t.user('wofficer', 'field_officer', 'phed');
  u.officer2 = await t.user('wofficer2', 'field_officer', 'phed');
  u.elecOfficer = await t.user('eofficer', 'field_officer', 'electricity');
  s = {
    admin: (await login(t.app, u.admin.username)).agent,
    head: (await login(t.app, u.head.username)).agent,
    officer: (await login(t.app, u.officer.username)).agent,
  };
});
after(() => t.cleanup());

const JPEG = Buffer.concat([Buffer.from([0xff, 0xd8, 0xff, 0xe0]), Buffer.from('proof photo')]);
const outbox = async (id) => (await t.pool.query(
  'select template_key, wa_hash, payload, status from grievance.notification_outbox where complaint_id = $1 order by id', [id])).rows;
const keys = async (id) => (await outbox(id)).map((r) => r.template_key);
async function close(agent, id, { remark = 'Pipe joint replaced', files = [['fix.jpg', JPEG]] } = {}) {
  let req = agent.post(`/portal/complaints/${id}/close`).field('_csrf', await tokenOf(agent)).field('remark', remark);
  for (const [name, buf] of files) req = req.attach('photos', buf, { filename: name, contentType: 'image/jpeg' });
  return req;
}

test('assign, start and close each queue one update for the citizen, with no staff names', async () => {
  const id = await t.complaint('N1', 'water_supply', 'phed');
  assert.deepEqual(await keys(id), [], 'filing is confirmed in the WhatsApp chat itself');

  await post(s.head, `/portal/complaints/${id}/assign`, { officer_id: String(u.officer.user_id), remark: 'urgent, call me' });
  const [a] = await outbox(id);
  assert.equal(a.template_key, 'status_assigned');
  assert.equal(a.wa_hash, 'h', 'addressed by the citizen hash only - the portal never sees the number');
  assert.equal(a.status, 'pending');
  assert.deepEqual(a.payload, { complaint_id: id, status: 'assigned' }, 'officer name and assignment remark stay internal');

  // a second officer, then the first again: the citizen was already told
  await post(s.head, `/portal/complaints/${id}/assign`, { officer_id: String(u.officer2.user_id) });
  await post(s.head, `/portal/complaints/${id}/assign`, { officer_id: String(u.officer.user_id) });
  assert.deepEqual(await keys(id), ['status_assigned']);

  await post(s.officer, `/portal/complaints/${id}/start`, { remark: 'on my way' });
  assert.deepEqual(await keys(id), ['status_assigned', 'status_in_progress']);
  assert.equal((await outbox(id))[1].payload.remark, undefined, 'start remarks stay internal');

  const r = await close(s.officer, id, { remark: 'Pipe joint replaced, water is back' });
  assert.equal(r.status, 302);
  const rows = await outbox(id);
  assert.deepEqual(rows.map((x) => x.template_key), ['status_assigned', 'status_in_progress', 'status_closed']);
  assert.deepEqual(rows[2].payload, { complaint_id: id, status: 'closed', remark: 'Pipe joint replaced, water is back' },
    'the closing note is what the citizen is told');
});

test('a refused close queues nothing (the update shares the status change\'s transaction)', async () => {
  const id = await t.complaint('N2', 'water_supply', 'phed', { status: 'in_progress', officer: u.officer.user_id });
  for (const bad of [{ files: [] }, { remark: 'x' }, { files: [['fake.jpg', Buffer.from('%PDF-1.4 not a photo')]] }]) {
    const r = await close(s.officer, id, bad);
    assert.equal(r.status, 400);
  }
  assert.deepEqual(await keys(id), []);
  assert.equal((await t.pool.query('select status from grievance.complaints where complaint_id = $1', [id])).rows[0].status, 'in_progress');
});

test('moving a complaint to another department and assigning it again does not repeat "assigned"', async () => {
  const id = await t.complaint('N3', 'water_supply', 'phed');
  await post(s.head, `/portal/complaints/${id}/assign`, { officer_id: String(u.officer.user_id) });
  const elec = await t.dept('electricity');
  await post(s.admin, `/portal/complaints/${id}/transfer`, { department_id: String(elec), remark: 'power fault, not water' });
  assert.equal((await t.pool.query('select status from grievance.complaints where complaint_id = $1', [id])).rows[0].status, 'open');
  await post(s.admin, `/portal/complaints/${id}/assign`, { officer_id: String(u.elecOfficer.user_id) });
  assert.deepEqual(await keys(id), ['status_assigned'], 'transfer itself is internal; the citizen hears "assigned" once');
});

test('the complaint page shows whether each update reached the citizen', async () => {
  const id = await t.complaint('N4', 'water_supply', 'phed');
  let page = (await s.head.get(`/portal/complaints/${id}`)).text;
  assert.match(page, /WhatsApp updates to the citizen/);
  assert.match(page, /None yet/);

  await post(s.head, `/portal/complaints/${id}/assign`, { officer_id: String(u.officer.user_id) });
  page = (await s.head.get(`/portal/complaints/${id}`)).text;
  assert.match(page, />Queued</);
  assert.match(page, /goes out within a minute/);

  // what n8n's poll writes back (svc_complaint.finish_notifications)
  await t.pool.query(`update grievance.notification_outbox set status = 'sent', sent_at = now(), attempts = 1, out_id = 'wamid.T'
                      where complaint_id = $1`, [id]);
  page = (await s.officer.get(`/portal/complaints/${id}`)).text;
  assert.match(page, />Sent</);
  assert.match(page, /Delivered to WhatsApp/);

  await t.pool.query(`update grievance.notification_outbox set status = 'pending', attempts = 2, last_error = 'HTTP 400: undeliverable',
                      next_attempt_at = now() + interval '4 minutes' where complaint_id = $1`, [id]);
  page = (await s.head.get(`/portal/complaints/${id}`)).text;
  assert.match(page, />Retrying</);
  assert.match(page, /attempt 2 failed/);

  await t.pool.query(`update grievance.notification_outbox set status = 'failed', attempts = 5 where complaint_id = $1`, [id]);
  page = (await s.head.get(`/portal/complaints/${id}`)).text;
  assert.match(page, />Failed</);
  assert.match(page, /Not delivered after 5 attempts: HTTP 400: undeliverable/);
  assert.doesNotMatch(page, /91\d{10}/, 'no phone number anywhere on the page');
});
