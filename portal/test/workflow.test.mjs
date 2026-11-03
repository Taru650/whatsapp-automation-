import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { setup, login, post } from './helpers.mjs';

const t = setup();
const u = {};
let s;
before(async () => {
  await t.ready;
  u.admin = await t.user('admin', 'district_admin');
  u.head = await t.user('whead', 'dept_head', 'phed');
  u.officer = await t.user('wofficer', 'field_officer', 'phed');
  u.disabledOfficer = await t.user('woff2', 'field_officer', 'phed', { enabled: false });
  u.elecOfficer = await t.user('eofficer', 'field_officer', 'electricity');
  s = {
    admin: (await login(t.app, u.admin.username)).agent,
    head: (await login(t.app, u.head.username)).agent,
    officer: (await login(t.app, u.officer.username)).agent,
  };
});
after(() => t.cleanup());

const row = async (id) => (await t.pool.query('select * from grievance.complaints where complaint_id = $1', [id])).rows[0];
const history = async (id) => (await t.pool.query(
  'select from_status, to_status, changed_by_user_id, remark from grievance.complaint_status_history where complaint_id = $1 order by id', [id])).rows;
const flashOf = async (agent, id) => (await agent.get(`/portal/complaints/${id}`)).text;

test('dept head assigns to an officer of their own department only', async () => {
  const id = await t.complaint('A1', 'water_supply', 'phed');
  for (const bad of [u.elecOfficer.user_id, u.disabledOfficer.user_id, u.head.user_id, 'x']) {
    const r = await post(s.head, `/portal/complaints/${id}/assign`, { officer_id: String(bad) });
    assert.equal(r.status, 302);
    assert.equal((await row(id)).assigned_officer_user_id, null, `not assigned to ${bad}`);
  }
  assert.match(await flashOf(s.head, id), /Choose an (active field officer|officer)/);

  const r = await post(s.head, `/portal/complaints/${id}/assign`, { officer_id: String(u.officer.user_id), remark: 'urgent - camp 3' });
  assert.equal(r.status, 302);
  const c = await row(id);
  assert.equal(c.status, 'assigned');
  assert.equal(Number(c.assigned_officer_user_id), Number(u.officer.user_id));
  const h = (await history(id)).at(-1);
  assert.equal(h.from_status, 'open');
  assert.equal(h.to_status, 'assigned');
  assert.equal(Number(h.changed_by_user_id), Number(u.head.user_id));
  assert.match(h.remark, /Assigned to wofficer .* - urgent - camp 3/);
});

test('a field officer cannot assign, and cannot touch a complaint that is not theirs', async () => {
  const id = await t.complaint('A2', 'water_supply', 'phed');
  const r = await post(s.officer, `/portal/complaints/${id}/assign`, { officer_id: String(u.officer.user_id) });
  assert.equal(r.status, 403);
  const start = await post(s.officer, `/portal/complaints/${id}/start`);
  assert.equal(start.status, 404, 'not assigned to them, so it does not exist for them');
  assert.equal((await row(id)).status, 'open');
});

test('the assigned officer starts work; start is only allowed from assigned', async () => {
  const id = await t.complaint('S1', 'water_supply', 'phed', { status: 'assigned', officer: u.officer.user_id });
  const r = await post(s.officer, `/portal/complaints/${id}/start`, { remark: 'reached the site' });
  assert.equal(r.status, 302);
  assert.equal((await row(id)).status, 'in_progress');
  assert.equal((await history(id)).at(-1).remark, 'reached the site');

  await post(s.officer, `/portal/complaints/${id}/start`);
  assert.equal((await history(id)).length, 2, 'starting twice changes nothing');
  assert.match(await flashOf(s.officer, id), /only be started on an assigned complaint/);
});

test('a dept head cannot reach another department\'s complaint even with a forged form', async () => {
  const id = await t.complaint('X1', 'electricity', 'electricity');
  const r = await post(s.head, `/portal/complaints/${id}/assign`, { officer_id: String(u.elecOfficer.user_id) });
  assert.equal(r.status, 404);
  assert.equal((await row(id)).assigned_officer_user_id, null);
});

test('only the district admin moves a misfiled complaint; it goes back to open, unassigned', async () => {
  const id = await t.complaint('T1', 'water_supply', 'phed', { status: 'assigned', officer: u.officer.user_id });
  const elec = await t.dept('electricity');
  assert.equal((await post(s.head, `/portal/complaints/${id}/transfer`, { department_id: String(elec) })).status, 403);

  const r = await post(s.admin, `/portal/complaints/${id}/transfer`, { department_id: String(elec), remark: 'power cut, not water' });
  assert.equal(r.status, 302);
  const c = await row(id);
  assert.equal(c.department_id, elec);
  assert.equal(c.status, 'open');
  assert.equal(c.assigned_officer_user_id, null);
  assert.match((await history(id)).at(-1).remark, /Moved from PHED .* to Electricity Board - power cut, not water/);
  assert.equal((await s.head.get(`/portal/complaints/${id}`)).status, 404, 'the water head no longer sees it');
});

test('a plain (non-upload) form can never close a complaint', async () => {
  const id = await t.complaint('R1', 'water_supply', 'phed', { status: 'in_progress', officer: u.officer.user_id });
  const r = await post(s.admin, `/portal/complaints/${id}/close`, { remark: 'done without proof' });
  assert.equal(r.status, 400);
  assert.equal((await row(id)).status, 'in_progress');
});
