import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import request from 'supertest';
import { setup, login, post, tokenOf, csrfOf, PASSWORD } from './helpers.mjs';

const t = setup({ PORTAL_LOGIN_LIMIT: '3' });
let admin;
let officer;
before(async () => {
  await t.ready;
  admin = await t.user('admin', 'district_admin');
  officer = await t.user('officer', 'field_officer', 'phed');
});
after(() => t.cleanup());

test('login: right password signs in, wrong/unknown/disabled all get the same message', async () => {
  const ok = await login(t.app, admin.username);
  assert.equal(ok.res.status, 302);
  assert.equal(ok.res.headers.location, '/portal/');
  assert.equal((await ok.agent.get('/portal/')).status, 200);

  for (const [u, p] of [[admin.username, 'wrong-password-here'], [`${t.run}_nobody`, PASSWORD]]) {
    const r = await login(t.app, u, p);
    assert.equal(r.res.status, 401);
    assert.match(r.res.text, /Wrong username or password/);
  }
  const disabled = await t.user('disabled', 'field_officer', 'phed', { enabled: false });
  const r = await login(t.app, disabled.username);
  assert.equal(r.res.status, 401);
  assert.match(r.res.text, /Wrong username or password/, 'a disabled account is not distinguishable from a wrong password');
});

test('anonymous requests are sent to the login page; static files and healthz are public', async () => {
  const r = await request(t.app).get('/portal/complaints');
  assert.equal(r.status, 302);
  assert.equal(r.headers.location, '/portal/login');
  assert.equal((await request(t.app).get('/portal/healthz')).body.ok, true);
  assert.equal((await request(t.app).get('/portal/static/bootstrap/css/bootstrap.min.css')).status, 200);
});

test('disabling an account ends its session on the very next request', async () => {
  const u = await t.user('victim', 'field_officer', 'phed');
  const { agent } = await login(t.app, u.username);
  assert.equal((await agent.get('/portal/')).status, 200);
  await t.pool.query('update grievance.portal_users set enabled = false where user_id = $1', [u.user_id]);
  const r = await agent.get('/portal/');
  assert.equal(r.status, 302);
  assert.equal(r.headers.location, '/portal/login');
});

test('every POST needs the session CSRF token', async () => {
  const { agent } = await login(t.app, admin.username);
  const r = await agent.post('/portal/settings/geofence').type('form').send({ radius: '500' });
  assert.equal(r.status, 403);
  const wrong = await agent.post('/portal/settings/geofence').type('form').send({ _csrf: 'a'.repeat(48), radius: '500' });
  assert.equal(wrong.status, 403);
  const anon = await request(t.app).post('/portal/login').type('form').send({ username: admin.username, password: PASSWORD });
  assert.equal(anon.status, 403, 'even the login form');
});

test('a reset password forces a change before anything else, and the old password stops working', async () => {
  const u = await t.user('fresh', 'field_officer', 'phed', { mustChange: true });
  const { agent } = await login(t.app, u.username);
  const r = await agent.get('/portal/complaints');
  assert.equal(r.status, 302);
  assert.equal(r.headers.location, '/portal/password');

  const bad = await post(agent, '/portal/password', { current: PASSWORD, password: 'short', confirm: 'short' });
  assert.equal(bad.status, 400);
  const mismatch = await post(agent, '/portal/password', { current: PASSWORD, password: 'new-password-1', confirm: 'new-password-2' });
  assert.equal(mismatch.status, 400);
  const ok = await post(agent, '/portal/password', { current: PASSWORD, password: 'brand-new-password', confirm: 'brand-new-password' });
  assert.equal(ok.status, 302);
  assert.equal((await agent.get('/portal/complaints')).status, 200);
  assert.equal((await login(t.app, u.username, PASSWORD)).res.status, 401);
  assert.equal((await login(t.app, u.username, 'brand-new-password')).res.status, 302);
});

test('login is rate-limited per username and IP', async () => {
  const name = officer.username;
  const statuses = [];
  for (let i = 0; i < 4; i++) statuses.push((await login(t.app, name, 'wrong-password-x')).res.status);
  assert.deepEqual(statuses, [401, 401, 401, 429]);
  const other = await login(t.app, admin.username);
  assert.equal(other.res.status, 302, 'another username from the same IP is not locked out');
});

test('logout ends the session', async () => {
  const { agent } = await login(t.app, admin.username);
  const token = await tokenOf(agent);
  assert.ok(token);
  await agent.post('/portal/logout').type('form').send({ _csrf: token });
  const r = await agent.get('/portal/');
  assert.equal(r.status, 302);
  assert.ok(csrfOf((await agent.get('/portal/login')).text));
});
