import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
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
  u.elecHead = await t.user('ehead', 'dept_head', 'electricity');
  s = {
    admin: (await login(t.app, u.admin.username)).agent,
    head: (await login(t.app, u.head.username)).agent,
    officer: (await login(t.app, u.officer.username)).agent,
    officer2: (await login(t.app, u.officer2.username)).agent,
    elecHead: (await login(t.app, u.elecHead.username)).agent,
  };
});
after(() => t.cleanup());

const JPEG = Buffer.concat([Buffer.from([0xff, 0xd8, 0xff, 0xe0]), Buffer.from('fake jpeg body')]);
const JPEG2 = Buffer.concat([Buffer.from([0xff, 0xd8, 0xff, 0xe1]), Buffer.from('another photo')]);
const PNG = Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), Buffer.from('fake png body')]);
const row = async (id) => (await t.pool.query('select * from grievance.complaints where complaint_id = $1', [id])).rows[0];
const officerEvidence = async (id) => (await t.pool.query(
  `select * from grievance.complaint_evidence where complaint_id = $1 and uploaded_by = 'officer' order by id`, [id])).rows;

// a multipart close, the way the browser form sends it
async function close(agent, id, { remark = 'Replaced the broken tap', files = [['fix.jpg', JPEG]], token } = {}) {
  let req = agent.post(`/portal/complaints/${id}/close`).field('_csrf', token ?? await tokenOf(agent)).field('remark', remark);
  for (const [name, buf, type = 'image/jpeg'] of files) req = req.attach('photos', buf, { filename: name, contentType: type });
  return req;
}

test('the assigned officer closes with photos + remark: closed, evidence on record and on disk', async () => {
  const id = await t.complaint('C1', 'water_supply', 'phed', { status: 'in_progress', officer: u.officer.user_id });
  const r = await close(s.officer, id, { files: [['a.jpg', JPEG], ['b.png', PNG, 'image/png'], ['a-again.jpg', JPEG]] });
  assert.equal(r.status, 302);
  const c = await row(id);
  assert.equal(c.status, 'closed');
  assert.ok(c.closed_at);
  const ev = await officerEvidence(id);
  assert.equal(ev.length, 2, 'the same photo picked twice is stored once');
  assert.deepEqual(ev.map((e) => e.mime_type).sort(), ['image/jpeg', 'image/png']);
  for (const e of ev) {
    assert.equal(Number(e.uploaded_by_user_id), Number(u.officer.user_id));
    assert.match(e.file_path, new RegExp(`^officer/${id}/[0-9a-f]{64}\\.(jpg|png)$`));
    assert.ok(fs.existsSync(path.join(t.mediaPath, e.file_path)), 'file written to the media volume');
  }
  const h = (await t.pool.query(`select * from grievance.complaint_status_history where complaint_id = $1 order by id desc limit 1`, [id])).rows[0];
  assert.equal(h.from_status, 'in_progress');
  assert.equal(h.to_status, 'closed');
  assert.equal(h.remark, 'Replaced the broken tap');
  const page = (await s.head.get(`/portal/complaints/${id}`)).text;
  assert.match(page, /Officer's proof/);
  assert.match(page, /Replaced the broken tap/);
  assert.equal((await s.head.get(`/portal/media/${ev[0].id}`)).status, 200, 'the head can see the proof');
  assert.equal((await s.elecHead.get(`/portal/media/${ev[0].id}`)).status, 404, 'another department cannot');
});

test('a closed complaint is final: no assigning, starting, moving or closing again', async () => {
  const id = await t.complaint('C2', 'water_supply', 'phed', { status: 'assigned', officer: u.officer.user_id });
  assert.equal((await close(s.officer, id)).status, 302, 'can close straight from assigned');
  assert.equal((await close(s.officer, id, { files: [['x.jpg', JPEG2]] })).status, 400);
  await post(s.head, `/portal/complaints/${id}/assign`, { officer_id: String(u.officer2.user_id) });
  await post(s.officer, `/portal/complaints/${id}/start`);
  await post(s.admin, `/portal/complaints/${id}/transfer`, { department_id: String(await t.dept('electricity')) });
  const c = await row(id);
  assert.equal(c.status, 'closed');
  assert.equal(Number(c.assigned_officer_user_id), Number(u.officer.user_id));
  assert.equal(c.department_id, await t.dept('phed'));
  assert.equal((await officerEvidence(id)).length, 1);
});

test('missing proof, a short remark, a non-image, or too many files are refused and nothing changes', async () => {
  const id = await t.complaint('C3', 'water_supply', 'phed', { status: 'in_progress', officer: u.officer.user_id });
  const cases = [
    [{ files: [] }, /at least one photo/],
    [{ remark: 'ok' }, /at least 5 characters/],
    [{ files: [['scan.jpg', Buffer.from('%PDF-1.4 not a photo')]] }, /not a JPG or PNG/],
    [{ files: [['heic.jpg', Buffer.from([0, 0, 0, 0x18, 0x66, 0x74, 0x79, 0x70, 0x68, 0x65, 0x69, 0x63])]] }, /not a JPG or PNG/],
    [{ files: Array.from({ length: 6 }, (_, i) => [`p${i}.jpg`, JPEG]) }, /at most 5 photos/],
  ];
  for (const [opts, msg] of cases) {
    const r = await close(s.officer, id, { remark: 'Replaced the broken tap', ...opts });
    assert.equal(r.status, 400, JSON.stringify(Object.keys(opts)));
    assert.match(r.text, msg);
  }
  assert.match((await close(s.officer, id, { remark: 'typed remark kept', files: [] })).text, /typed remark kept/, 'the typed remark survives an error');
  assert.equal((await row(id)).status, 'in_progress');
  assert.equal((await officerEvidence(id)).length, 0);
  assert.deepEqual(fs.existsSync(path.join(t.mediaPath, 'officer', id)) ? fs.readdirSync(path.join(t.mediaPath, 'officer', id)) : [], [], 'no orphan files');
});

test('only those who can see the complaint can close it', async () => {
  const id = await t.complaint('C4', 'water_supply', 'phed', { status: 'in_progress', officer: u.officer.user_id });
  assert.equal((await close(s.officer2, id)).status, 404, 'another officer of the same department');
  assert.equal((await close(s.elecHead, id)).status, 404, 'another department\'s head');
  assert.equal((await row(id)).status, 'in_progress');
  assert.equal((await close(s.head, id)).status, 302, 'the department head may close it with proof');
});

test('CSRF: an upload without the token is refused, and no other route accepts multipart at all', async () => {
  const id = await t.complaint('C5', 'water_supply', 'phed', { status: 'in_progress', officer: u.officer.user_id });
  assert.equal((await close(s.officer, id, { token: '' })).status, 403);
  assert.equal((await close(s.officer, id, { token: 'a'.repeat(48) })).status, 403);
  assert.equal((await row(id)).status, 'in_progress');
  // a cross-site multipart form must not slip past CSRF on routes that need no body
  const r = await s.head.post(`/portal/users/${u.officer2.user_id}/disable`).field('x', '1');
  assert.equal(r.status, 403);
  assert.equal((await t.pool.query('select enabled from grievance.portal_users where user_id = $1', [u.officer2.user_id])).rows[0].enabled, true);
});

test('the database refuses a close with only the citizen\'s photo, whatever the app does', async () => {
  const id = await t.complaint('C6', 'water_supply', 'phed', { status: 'in_progress', officer: u.officer.user_id });
  await t.evidence(id, `h/${id}.png`);
  await t.pool.query(`insert into grievance.complaint_status_history (complaint_id, from_status, to_status, remark) values ($1, 'in_progress', 'closed', 'sneaky')`, [id]);
  await assert.rejects(t.pool.query(`update grievance.complaints set status = 'closed' where complaint_id = $1`, [id]), /uploaded by an officer/);
});
