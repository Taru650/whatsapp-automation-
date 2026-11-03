import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { setup, login } from './helpers.mjs';

const t = setup();
const ids = {};
let s;
before(async () => {
  await t.ready;
  const admin = await t.user('admin', 'district_admin');
  const head = await t.user('whead', 'dept_head', 'phed');
  const officer = await t.user('wofficer', 'field_officer', 'phed');
  const other = await t.user('wofficer2', 'field_officer', 'phed');
  ids.W1 = await t.complaint('W1', 'water_supply', 'phed', { status: 'assigned', officer: officer.user_id });
  ids.W2 = await t.complaint('W2', 'water_supply', 'phed');
  ids.E1 = await t.complaint('E1', 'electricity', 'electricity');
  ids.eW1 = await t.evidence(ids.W1, 'h/w1.png');
  ids.eE1 = await t.evidence(ids.E1, 'h/e1.png');
  ids.escape = await t.evidence(ids.W1, '../../../etc/passwd', 'image/png', false);
  s = {
    admin: (await login(t.app, admin.username)).agent,
    head: (await login(t.app, head.username)).agent,
    officer: (await login(t.app, officer.username)).agent,
    other: (await login(t.app, other.username)).agent,
  };
});
after(() => t.cleanup());

async function visible(agent) {
  const out = [];
  for (const k of ['W1', 'W2', 'E1']) if ((await agent.get(`/portal/complaints/${ids[k]}`)).status === 200) out.push(k);
  return out;
}

test('each role sees exactly its scope on the detail page (others are a 404, not a 403)', async () => {
  assert.deepEqual(await visible(s.admin), ['W1', 'W2', 'E1']);
  assert.deepEqual(await visible(s.head), ['W1', 'W2'], 'dept head: own department only');
  assert.deepEqual(await visible(s.officer), ['W1'], 'officer: only what is assigned to them');
  assert.deepEqual(await visible(s.other), [], 'an officer with nothing assigned sees nothing');
  assert.equal((await s.head.get(`/portal/complaints/${ids.E1}`)).status, 404);
});

test('the list page and dashboard follow the same scope', async () => {
  const listed = async (agent) => {
    const html = (await agent.get(`/portal/complaints?q=${t.run}`)).text;
    return ['W1', 'W2', 'E1'].filter((k) => html.includes(`>${ids[k]}<`));
  };
  assert.deepEqual((await listed(s.admin)).sort(), ['E1', 'W1', 'W2']);
  assert.deepEqual((await listed(s.head)).sort(), ['W1', 'W2']);
  assert.deepEqual(await listed(s.officer), ['W1']);
  assert.deepEqual(await listed(s.other), []);
  assert.equal((await s.officer.get('/portal/')).status, 200);
});

test('evidence files follow the complaint\'s visibility, and never escape the media folder', async () => {
  const media = (agent, id) => agent.get(`/portal/media/${id}`);
  assert.equal((await media(s.admin, ids.eE1)).status, 200);
  assert.equal((await media(s.head, ids.eE1)).status, 404, 'another department\'s photo');
  assert.equal((await media(s.head, ids.eW1)).status, 200);
  const r = await media(s.officer, ids.eW1);
  assert.equal(r.status, 200);
  assert.equal(r.headers['content-type'], 'image/png');
  assert.match(r.headers['cache-control'], /private/);
  assert.equal((await media(s.admin, ids.escape)).status, 404, 'a ../ path stored in the DB is refused');
  assert.equal((await media(s.admin, 'abc')).status, 404);
});

test('role-only pages', async () => {
  assert.equal((await s.officer.get('/portal/users')).status, 403);
  assert.equal((await s.officer.get('/portal/settings/geofence')).status, 403);
  assert.equal((await s.head.get('/portal/settings/geofence')).status, 403);
  assert.equal((await s.head.get('/portal/users')).status, 200);
  assert.equal((await s.admin.get('/portal/settings/geofence')).status, 200);
});
