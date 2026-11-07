// Usage page: district admin only, aggregates only, never a phone number.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { setup, login, adminPool } from './helpers.mjs';
import { groupTopics } from '../src/routes/usage.js';
import { topicLabel } from '../src/labels.js';

const t = setup();
const admin = adminPool();
const PHONE = '9876543210';
let tag;
let a; let head; let officer;
let sAdmin; let sHead; let sOfficer;

before(async () => {
  await t.ready;
  tag = `u${Date.now().toString(36)}${Math.floor(Math.random() * 1e4)}`;
  const adminUser = await t.user('admin', 'district_admin');
  const headUser = await t.user('head', 'dept_head', 'phed');
  const officerUser = await t.user('officer', 'field_officer', 'phed');
  a = adminUser; head = headUser; officer = officerUser;
  sAdmin = (await login(t.app, adminUser.username)).agent;
  sHead = (await login(t.app, headUser.username)).agent;
  sOfficer = (await login(t.app, officerUser.username)).agent;
  // (citizen ids differ in their first 10 characters, like real 64-hex hashes:
  // the analytics views count citizens by that 10-character reference)
  // two citizens today: one asks for police stations twice, one files a complaint;
  // one question the bot could not answer, with a phone number typed in it
  const rows = [
    [`c1${tag}`, 'mela', 'thana'], [`c1${tag}`, 'mela', 'thana_roster'], [`c2${tag}`, 'complaint', 'registered'],
  ];
  let i = 0;
  for (const [h, svc, sub] of rows) {
    await admin.query(`insert into core.message_log (wa_msg_id, wa_hash, direction, service_key, subtype, kind, text, resolved)
                       values ($1, $2, 'in', $3, $4, 'text', $5, true)`, [`${tag}m${i++}`, h, svc, sub, `call me on ${PHONE}`]);
  }
  await admin.query(`insert into core.unanswered (wa_hash, text, service_key, reason) values ($1, $2, 'mela', 'qa_no_answer')`,
    [`c1${tag}`, `${tag} where is the ticket counter, my number ${PHONE}`]);
});

after(async () => {
  await admin.query('delete from core.message_log where wa_hash like $1', [`%${tag}`]);
  await admin.query('delete from core.unanswered where wa_hash like $1', [`%${tag}`]);
  await admin.end();
  await t.cleanup();
});

test('the district admin sees citizens per day, top topics and unanswered questions', async () => {
  const r = await sAdmin.get('/portal/usage?days=7');
  assert.equal(r.status, 200);
  assert.match(r.text, /WhatsApp usage/);
  assert.match(r.text, /Police stations/, 'thana and its roster are one plain-language topic');
  assert.match(r.text, /Complaint filed/);
  assert.match(r.text, new RegExp(`${tag} where is the ticket counter`), 'the unanswered question is listed');
  assert.match(r.text, /id="chart-usage"/);
  const data = JSON.parse(r.text.match(/<script type="application\/json" id="usage-data">([\s\S]*?)<\/script>/)[1]);
  assert.equal(data.labels.length, 7, 'one bar per day, including days with no messages');
  assert.ok(data.citizens[6] >= 2, 'today counts both citizens');
});

test('no phone number and no citizen id ever reaches the page', async () => {
  const r = await sAdmin.get('/portal/usage?days=7');
  assert.ok(!r.text.includes(PHONE), 'typed number masked');
  assert.ok(!r.text.includes(`c1${tag}`.slice(0, 10)) && !r.text.includes(`c2${tag}`.slice(0, 10)), 'no citizen hash or reference');
});

test('only the district admin: heads and officers are refused, and see no menu link', async () => {
  for (const s of [sHead, sOfficer]) {
    const r = await s.get('/portal/usage');
    assert.equal(r.status, 403);
    assert.ok(!r.text.includes('WhatsApp usage'));
    const home = await s.get('/portal/');
    assert.ok(!home.text.includes('/portal/usage'), 'no Usage link in their menu');
  }
  const home = await sAdmin.get('/portal/');
  assert.match(home.text, /href="\/portal\/usage"/);
});

test('the database refuses the figures to anyone but an enabled district admin', async () => {
  for (const uid of [head.user_id, officer.user_id, -1]) {
    await assert.rejects(t.pool.query('select grievance.usage_report($1, 7)', [uid]), /district admin only/);
  }
  await t.pool.query('update grievance.portal_users set enabled = false where user_id = $1', [a.user_id]);
  await assert.rejects(t.pool.query('select grievance.usage_report($1, 7)', [a.user_id]), /district admin only/);
  await t.pool.query('update grievance.portal_users set enabled = true where user_id = $1', [a.user_id]);
  // and portal_rw still cannot read the raw log behind it
  await assert.rejects(t.pool.query('select count(*) from core.message_log'), /permission denied/);
  await assert.rejects(t.pool.query('select count(*) from analytics.v_turns'), /permission denied/);
});

test('unknown period falls back to 14 days; topic labels group related codes', async () => {
  const r = await sAdmin.get('/portal/usage?days=999');
  assert.equal(r.status, 200);
  assert.match(r.text, /last 14 days/);
  assert.equal(topicLabel('mela', 'near_thana'), 'Near me');
  assert.equal(topicLabel('mela', 'vet_camp_roster'), 'Veterinary camps');
  assert.equal(topicLabel('complaint', 'evidence_added'), 'Filing a complaint (steps)');
  assert.equal(topicLabel('(core)', 'feedback'), 'Feedback 👍/👎');
  assert.deepEqual(groupTopics([
    { service_key: 'mela', subtype: 'thana', messages: 2 }, { service_key: 'mela', subtype: 'thana_roster', messages: 1 },
    { service_key: 'complaint', subtype: 'mine', messages: 4 },
  ]).map((g) => [g.label, g.messages]), [['Status check', 4], ['Police stations', 3]]);
});
