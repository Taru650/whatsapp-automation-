// The portal under its PRODUCTION settings (every other test file runs ENV=test,
// which turns cookie security off - and so once hid that no one could sign in
// through the documented SSH tunnel: a hard Secure cookie is never set over http).
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import request from 'supertest';
import { loadConfig } from '../src/config.js';
import { setup, csrfOf } from './helpers.mjs';

const t = setup({ ENV: 'prod', PORTAL_SESSION_SECRET: 'p'.repeat(64), PORTAL_TRUST_PROXY: '1' });
let admin;
before(async () => {
  await t.ready;
  admin = await t.user('admin', 'district_admin');
});
after(() => t.cleanup());

async function signIn(headers = {}) {
  const agent = request.agent(t.app);
  const page = await agent.get('/portal/login').set(headers);
  const res = await agent.post('/portal/login').set(headers).type('form')
    .send({ _csrf: csrfOf(page.text), username: admin.username, password: 'correct-horse-battery' });
  return { agent, page, res };
}

test('config: production uses auto-secure cookies and trusts one proxy; a weak secret refuses to start', () => {
  const prod = loadConfig({ ENV: 'prod', PORTAL_SESSION_SECRET: 'x'.repeat(64) });
  assert.equal(prod.secureCookie, 'auto');
  assert.equal(prod.trustProxy, 1);
  assert.equal(loadConfig({ ENV: 'test' }).secureCookie, false);
  assert.throws(() => loadConfig({ ENV: 'prod', PORTAL_SESSION_SECRET: 'change-me' }), /PORTAL_SESSION_SECRET/);
  assert.throws(() => loadConfig({ ENV: 'prod' }), /PORTAL_SESSION_SECRET/);
});

test('direct http (SSH tunnel to 127.0.0.1:3001): sign-in works, cookie is httpOnly but not Secure', async () => {
  const { agent, page, res } = await signIn();
  const cookie = String(page.headers['set-cookie'] || '');
  assert.match(cookie, /HttpOnly/i);
  assert.doesNotMatch(cookie, /;\s*Secure/i, 'a Secure cookie would never come back over plain http');
  assert.equal(res.status, 302);
  assert.equal(res.headers.location, '/portal/');
  const dash = await agent.get('/portal/');
  assert.equal(dash.status, 200, 'still signed in on the next request');
});

test('through Caddy over https (X-Forwarded-Proto: https): the session cookie is Secure', async () => {
  // cookies carried by hand: supertest's jar (rightly) won't send a Secure cookie
  // back over the test's plain-http socket, where a browser on https would
  const https = { 'X-Forwarded-Proto': 'https' };
  const page = await request(t.app).get('/portal/login').set(https);
  const set = String(page.headers['set-cookie'] || '');
  assert.match(set, /;\s*Secure/i);
  const cookie = set.split(';')[0];
  const res = await request(t.app).post('/portal/login').set(https).set('Cookie', cookie).type('form')
    .send({ _csrf: csrfOf(page.text), username: admin.username, password: 'correct-horse-battery' });
  assert.equal(res.status, 302);
  assert.equal(res.headers.location, '/portal/');
  const rotated = String(res.headers['set-cookie'] || '').split(';')[0]; // session id is rotated at sign-in
  assert.match(String(res.headers['set-cookie'] || ''), /;\s*Secure/i);
  assert.equal((await request(t.app).get('/portal/').set(https).set('Cookie', rotated)).status, 200);
  assert.match(String(res.headers['strict-transport-security'] || ''), /max-age=/, 'HSTS on the public site');
});
