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
  u.elecOfficer = await t.user('eofficer', 'field_officer', 'electricity');
  u.elecHead = await t.user('ehead', 'dept_head', 'electricity');
  s = {
    admin: (await login(t.app, u.admin.username)).agent,
    head: (await login(t.app, u.head.username)).agent,
  };
});
after(() => t.cleanup());

const byName = async (username) => (await t.pool.query('select * from grievance.portal_users where username = $1', [username])).rows[0];

test('dept head creates field officers, always in their own department, with a forced password change', async () => {
  const elec = await t.dept('electricity');
  const r = await post(s.head, '/portal/users/new', {
    username: `${t.run}_new1`, full_name: 'New Officer', role: 'field_officer', department_id: String(elec), password: 'first-password-1',
  });
  assert.equal(r.status, 302);
  const created = await byName(`${t.run}_new1`);
  assert.equal(created.role, 'field_officer');
  assert.equal(created.department_id, await t.dept('phed'), 'the department field is ignored for a head');
  assert.equal(created.must_change_password, true);
  assert.equal(Number(created.created_by_user_id), Number(u.head.user_id));
});

test('dept head cannot create a dept head or a district admin', async () => {
  for (const role of ['dept_head', 'district_admin']) {
    const r = await post(s.head, '/portal/users/new', { username: `${t.run}_bad_${role}`, full_name: 'X Y', role, password: 'first-password-1' });
    assert.equal(r.status, 403);
    assert.equal(await byName(`${t.run}_bad_${role}`), undefined);
  }
});

test('admin creates a dept head; validation errors and duplicate usernames are reported', async () => {
  const r = await post(s.admin, '/portal/users/new', {
    username: `${t.run}_head2`, full_name: 'Police Head', role: 'dept_head', department_id: String(await t.dept('police')), password: 'first-password-1',
  });
  assert.equal(r.status, 302);
  assert.equal((await byName(`${t.run}_head2`)).role, 'dept_head');

  const dup = await post(s.admin, '/portal/users/new', {
    username: `${t.run}_head2`, full_name: 'Again', role: 'field_officer', department_id: String(await t.dept('police')), password: 'first-password-1',
  });
  assert.equal(dup.status, 400);
  assert.match(dup.text, /already taken/);
  const short = await post(s.admin, '/portal/users/new', { username: `${t.run}_x`, full_name: 'Short', role: 'district_admin', password: 'short' });
  assert.equal(short.status, 400);
  const noDept = await post(s.admin, '/portal/users/new', { username: `${t.run}_nod`, full_name: 'No Dept', role: 'field_officer', password: 'first-password-1' });
  assert.equal(noDept.status, 400);
  assert.equal(await byName(`${t.run}_nod`), undefined);
});

test('dept head manages only their own field officers, and nobody can disable themselves', async () => {
  for (const target of [u.elecOfficer, u.elecHead, u.admin, u.head]) {
    const r = await post(s.head, `/portal/users/${target.user_id}/disable`);
    assert.equal(r.status, 403, `head must not disable ${target.username}`);
  }
  assert.equal((await post(s.admin, `/portal/users/${u.admin.user_id}/disable`)).status, 403, 'admin cannot lock themselves out');

  assert.equal((await post(s.head, `/portal/users/${u.officer.user_id}/disable`)).status, 302);
  assert.equal((await byName(u.officer.username)).enabled, false);
  assert.equal((await post(s.head, `/portal/users/${u.officer.user_id}/enable`)).status, 302);
  assert.equal((await byName(u.officer.username)).enabled, true);
});

test('a password reset shows a one-time password that works and forces a change', async () => {
  const r = await post(s.head, `/portal/users/${u.officer.user_id}/reset-password`);
  assert.equal(r.status, 200);
  const temp = /user-select-all">([A-Za-z0-9]{12})</.exec(r.text)[1];
  assert.equal((await byName(u.officer.username)).must_change_password, true);
  const { agent, res } = await login(t.app, u.officer.username, temp);
  assert.equal(res.status, 302);
  const next = await agent.get('/portal/');
  assert.equal(next.headers.location, '/portal/password');
  const audit = await t.pool.query(`select detail from grievance.portal_audit where action = 'user_reset_password' and target = $1`, [String(u.officer.user_id)]);
  assert.equal(audit.rows.length, 1);
  assert.doesNotMatch(JSON.stringify(audit.rows), new RegExp(temp), 'the temporary password is never stored');
});
