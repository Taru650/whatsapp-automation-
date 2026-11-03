import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import ExcelJS from 'exceljs';
import { setup, login } from './helpers.mjs';
import { parseFilters } from '../src/routes/reports.js';

const t = setup();
const u = {};
const ids = {};
let s;
before(async () => {
  await t.ready;
  u.admin = await t.user('admin', 'district_admin');
  u.head = await t.user('whead', 'dept_head', 'phed');
  u.officer = await t.user('wofficer', 'field_officer', 'phed');
  ids.W1 = await t.complaint('W1', 'water_supply', 'phed', { status: 'assigned', officer: u.officer.user_id });
  ids.W2 = await t.complaint('W2', 'water_supply', 'phed');
  ids.E1 = await t.complaint('E1', 'electricity', 'electricity');
  await t.pool.query(`update grievance.complaints set description = 'नल से पानी नहीं आ रहा =SUM(A1)' where complaint_id = $1`, [ids.W2]);
  s = {
    admin: (await login(t.app, u.admin.username)).agent,
    head: (await login(t.app, u.head.username)).agent,
    officer: (await login(t.app, u.officer.username)).agent,
  };
});
after(() => t.cleanup());

const binary = (res, cb) => { const chunks = []; res.on('data', (c) => chunks.push(c)); res.on('end', () => cb(null, Buffer.concat(chunks))); };

// complaint ids in the Complaints sheet that belong to this test run
async function xlsxIds(agent, qs = '') {
  const r = await agent.get(`/portal/reports/complaints.xlsx${qs}`).buffer(true).parse(binary);
  assert.equal(r.status, 200);
  assert.match(r.headers['content-disposition'], /attachment; filename="complaints-\d{8}\.xlsx"/);
  const wb = new ExcelJS.Workbook();
  await wb.xlsx.load(r.body);
  const sheet = wb.getWorksheet('Complaints');
  const rows = [];
  sheet.eachRow((row, n) => { if (n > 1) rows.push(row); });
  return { wb, rows: rows.filter((row) => String(row.getCell(1).value).startsWith(t.run.toUpperCase())) };
}

test('Excel follows each role\'s scope', async () => {
  const short = (rows) => rows.map((r) => String(r.getCell(1).value).split('-').pop()).sort();
  assert.deepEqual(short((await xlsxIds(s.admin)).rows), ['E1', 'W1', 'W2']);
  assert.deepEqual(short((await xlsxIds(s.head)).rows), ['W1', 'W2']);
  assert.deepEqual(short((await xlsxIds(s.officer)).rows), ['W1']);
});

test('Excel: filters, Hindi text survives, and a leading "=" stays text (no formula injection)', async () => {
  const { rows } = await xlsxIds(s.admin, `?department=${await t.dept('phed')}&status=open`);
  assert.deepEqual(rows.map((r) => String(r.getCell(1).value)), [ids.W2]);
  const desc = rows[0].getCell(12);
  assert.equal(desc.value, 'नल से पानी नहीं आ रहा =SUM(A1)');
  assert.equal(desc.formula, undefined);
  assert.equal(rows[0].getCell(4).value, 'पानी की समस्या');
  const { wb } = await xlsxIds(s.admin);
  const summary = wb.getWorksheet('Summary');
  assert.match(String(summary.getCell('A2').value), /Filters: all complaints/);
});

test('PDF downloads and is a real PDF', async () => {
  const r = await s.head.get(`/portal/reports/complaints.pdf?from=2020-01-01&overdue=`).buffer(true).parse(binary);
  assert.equal(r.status, 200);
  assert.equal(r.headers['content-type'], 'application/pdf');
  assert.equal(r.body.subarray(0, 5).toString(), '%PDF-');
  assert.ok(r.body.length > 1500);
});

test('bad filters are refused; every download is audited', async () => {
  for (const qs of ['?from=2026-13-45', '?from=2026-11-10&to=2026-11-01', '?status=nope', '?from=yesterday']) {
    assert.equal((await s.admin.get(`/portal/reports/complaints.xlsx${qs}`)).status, 400, qs);
  }
  assert.equal((await s.admin.get('/portal/reports?from=bad')).status, 400);
  assert.equal((await s.admin.get('/portal/reports')).status, 200);
  const n = (await t.pool.query(`select count(*)::int as n from grievance.portal_audit where user_id = $1 and action like 'report_%'`, [u.admin.user_id])).rows[0].n;
  assert.ok(n >= 3, `downloads audited (${n})`);
});

test('parseFilters: a non-admin cannot filter by department (their scope already decides)', () => {
  assert.equal(parseFilters({ department: '3' }, { role: 'dept_head' }).value.department, '');
  assert.equal(parseFilters({ department: '3' }, { role: 'district_admin' }).value.department, 3);
});
