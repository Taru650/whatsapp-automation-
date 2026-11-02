import express from 'express';
import ExcelJS from 'exceljs';
import PDFDocument from 'pdfkit';
import { audit } from '../db.js';
import { STATUSES, STATUS_LABEL, fmtTime } from '../labels.js';

export const XLSX_CAP = 20000;
export const PDF_CAP = 2000;
const DATE = /^\d{4}-\d{2}-\d{2}$/;

// Returns { value } or { error }. Empty fields mean "no filter".
export function parseFilters(q, user) {
  const f = { from: '', to: '', status: '', category: '', department: '', overdue: false };
  for (const k of ['from', 'to']) {
    const v = String(q[k] || '');
    if (!v) continue;
    if (!DATE.test(v) || Number.isNaN(Date.parse(`${v}T00:00:00Z`))) return { error: 'Dates must be YYYY-MM-DD.' };
    f[k] = v;
  }
  if (f.from && f.to && f.from > f.to) return { error: 'The "from" date is after the "to" date.' };
  if (q.status) {
    if (!STATUSES.includes(q.status)) return { error: 'Unknown status.' };
    f.status = q.status;
  }
  if (q.category) {
    if (!/^[a-z_]{1,40}$/.test(q.category)) return { error: 'Unknown category.' };
    f.category = q.category;
  }
  if (q.department && user.role === 'district_admin') {
    if (!/^\d{1,6}$/.test(q.department)) return { error: 'Unknown department.' };
    f.department = Number(q.department);
  }
  f.overdue = q.overdue === '1';
  return { value: f };
}

// Every row comes from complaints_visible_to(user): a field officer's report
// holds only their own complaints, a head's only their department's.
function filterSql(user, f) {
  const params = [user.user_id];
  const where = [];
  const add = (sql, v) => { params.push(v); where.push(sql.replace('?', `$${params.length}`)); };
  if (f.from) add("(c.created_at at time zone 'Asia/Kolkata')::date >= ?::date", f.from);
  if (f.to) add("(c.created_at at time zone 'Asia/Kolkata')::date <= ?::date", f.to);
  if (f.status) add('c.status = ?', f.status);
  if (f.category) add('c.category_key = ?', f.category);
  if (f.department) add('c.department_id = ?', f.department);
  if (f.overdue) where.push("c.due_at < now() and c.status not in ('resolved', 'closed')");
  return { params, where: where.length ? `where ${where.join(' and ')}` : '' };
}

async function fetchRows(pool, user, f, limit) {
  const { params, where } = filterSql(user, f);
  const { rows } = await pool.query(`
    select c.complaint_id, c.created_at, c.due_at, c.closed_at, c.status, c.description, c.lat, c.lon,
           cat.label_en as category_en, cat.label_hi as category_hi, d.name_en as department_en,
           o.full_name as officer_name,
           (c.due_at < now() and c.status not in ('resolved', 'closed')) as overdue,
           (select h.remark from grievance.complaint_status_history h
             where h.complaint_id = c.complaint_id and h.to_status = 'closed' order by h.id desc limit 1) as closure_remark
    from grievance.complaints_visible_to($1) c
    join grievance.complaint_categories cat on cat.category_key = c.category_key
    join grievance.departments d on d.department_id = c.department_id
    left join grievance.portal_users o on o.user_id = c.assigned_officer_user_id
    ${where}
    order by c.created_at desc limit ${limit + 1}`, params);
  return { rows: rows.slice(0, limit), truncated: rows.length > limit };
}

async function fetchSummary(pool, user, f) {
  const { params, where } = filterSql(user, f);
  const { rows } = await pool.query(`
    select d.name_en as department,
           count(*) filter (where c.status = 'open')::int as open,
           count(*) filter (where c.status = 'assigned')::int as assigned,
           count(*) filter (where c.status = 'in_progress')::int as in_progress,
           count(*) filter (where c.status = 'closed')::int as closed,
           count(*) filter (where c.due_at < now() and c.status not in ('resolved', 'closed'))::int as overdue,
           count(*)::int as total
    from grievance.complaints_visible_to($1) c
    join grievance.departments d on d.department_id = c.department_id
    ${where}
    group by d.name_en order by d.name_en`, params);
  return rows;
}

function describeFilters(f, names) {
  const parts = [];
  if (f.from || f.to) parts.push(`filed ${f.from || '…'} to ${f.to || '…'}`);
  if (f.status) parts.push(`status ${STATUS_LABEL[f.status]}`);
  if (f.category) parts.push(`category ${names.category || f.category}`);
  if (f.department) parts.push(`department ${names.department || f.department}`);
  if (f.overdue) parts.push('overdue only');
  return parts.length ? parts.join(', ') : 'all complaints in your area of work';
}

const days = (a, b) => (a && b ? Math.max(0, Math.round((new Date(b) - new Date(a)) / 86400000 * 10) / 10) : null);
const stamp = () => new Date(Date.now() + 5.5 * 3600e3).toISOString().slice(0, 10).replace(/-/g, '');
// The PDF uses the built-in Helvetica font, which has no Devanagari (pdfkit can't
// shape Hindi conjuncts anyway): anything outside Latin-1 becomes '?'.
const latin1 = (s) => String(s ?? '').replace(/[^\x20-\x7e\xa0-\xff]/g, '?');

async function writeXlsx(res, rows, summary, meta) {
  const wb = new ExcelJS.stream.xlsx.WorkbookWriter({ stream: res, useSharedStrings: false });
  wb.creator = 'Saran Complaints portal';
  const ws = wb.addWorksheet('Complaints', { views: [{ state: 'frozen', ySplit: 1 }] });
  ws.columns = [
    { header: 'Complaint ID', key: 'id', width: 18 }, { header: 'Filed', key: 'filed', width: 18 },
    { header: 'Category', key: 'cat', width: 22 }, { header: 'Category (Hindi)', key: 'cat_hi', width: 22 },
    { header: 'Department', key: 'dept', width: 26 }, { header: 'Status', key: 'status', width: 12 },
    { header: 'Overdue', key: 'overdue', width: 9 }, { header: 'Officer', key: 'officer', width: 20 },
    { header: 'Due', key: 'due', width: 18 }, { header: 'Closed', key: 'closed', width: 18 },
    { header: 'Days to close', key: 'days', width: 13 }, { header: 'Description', key: 'desc', width: 50 },
    { header: 'Latitude', key: 'lat', width: 11 }, { header: 'Longitude', key: 'lon', width: 11 },
    { header: 'Map', key: 'map', width: 8 }, { header: 'Closure remark', key: 'remark', width: 40 },
  ];
  ws.getRow(1).font = { bold: true };
  for (const c of rows) {
    // plain string cells: a description starting with "=" is stored as text, never a formula
    ws.addRow({
      id: c.complaint_id, filed: fmtTime(c.created_at), cat: c.category_en, cat_hi: c.category_hi, dept: c.department_en,
      status: STATUS_LABEL[c.status], overdue: c.overdue ? 'Yes' : '', officer: c.officer_name || '',
      due: fmtTime(c.due_at), closed: fmtTime(c.closed_at), days: days(c.created_at, c.closed_at), desc: c.description,
      lat: c.lat, lon: c.lon, map: { text: 'map', hyperlink: `https://www.google.com/maps/search/?api=1&query=${c.lat},${c.lon}` },
      remark: c.closure_remark || '',
    }).commit();
  }
  if (meta.truncated) ws.addRow({ id: `Only the newest ${XLSX_CAP} complaints are included - narrow the filters for the rest.` }).commit();
  ws.commit();

  const s = wb.addWorksheet('Summary');
  s.addRow(['Saran Complaints report']).commit();
  s.addRow([`Filters: ${meta.filters}`]).commit();
  s.addRow([`Generated ${fmtTime(new Date())} by ${meta.by}`]).commit();
  s.addRow([]).commit();
  const head = s.addRow(['Department', 'Open', 'Assigned', 'In progress', 'Closed', 'Overdue', 'Total']);
  head.font = { bold: true };
  head.commit();
  for (const x of summary) s.addRow([x.department, x.open, x.assigned, x.in_progress, x.closed, x.overdue, x.total]).commit();
  s.getColumn(1).width = 30;
  s.commit();
  await wb.commit();
}

function writePdf(res, rows, summary, meta) {
  const doc = new PDFDocument({ size: 'A4', layout: 'landscape', margin: 30, info: { Title: 'Saran Complaints report', Author: 'Saran Complaints portal' } });
  doc.pipe(res);
  const left = 30;
  const width = doc.page.width - 60;
  const bottom = doc.page.height - 40;

  doc.font('Helvetica-Bold').fontSize(15).text('Saran Complaints - report', left, 30);
  doc.font('Helvetica').fontSize(9).fillColor('#444')
    .text(latin1(`Filters: ${meta.filters}`)).text(latin1(`Generated ${fmtTime(new Date())} by ${meta.by}`)).fillColor('black');
  doc.moveDown(0.8);

  function table(cols, data, { bold = false } = {}) {
    const rowH = 16;
    const header = () => {
      let x = left;
      doc.font('Helvetica-Bold').fontSize(8);
      doc.rect(left, doc.y - 2, width, rowH).fill('#e9ecef').fillColor('black');
      const y = doc.y;
      for (const col of cols) { doc.text(col.title, x + 3, y + 2, { width: col.w - 6, lineBreak: false, ellipsis: true }); x += col.w; }
      doc.y = y + rowH;
    };
    header();
    doc.font(bold ? 'Helvetica-Bold' : 'Helvetica').fontSize(8);
    for (const row of data) {
      if (doc.y + rowH > bottom) { doc.addPage(); doc.y = 30; header(); doc.font('Helvetica').fontSize(8); }
      const y = doc.y;
      let x = left;
      for (const col of cols) { doc.text(latin1(row[col.key]), x + 3, y + 2, { width: col.w - 6, lineBreak: false, ellipsis: true }); x += col.w; }
      doc.moveTo(left, y + rowH).lineTo(left + width, y + rowH).lineWidth(0.3).strokeColor('#dee2e6').stroke();
      doc.y = y + rowH;
    }
    doc.x = left;
  }

  doc.font('Helvetica-Bold').fontSize(11).text('Summary by department', left);
  doc.moveDown(0.3);
  const total = summary.reduce((a, x) => ({ open: a.open + x.open, assigned: a.assigned + x.assigned, in_progress: a.in_progress + x.in_progress,
    closed: a.closed + x.closed, overdue: a.overdue + x.overdue, total: a.total + x.total }), { open: 0, assigned: 0, in_progress: 0, closed: 0, overdue: 0, total: 0 });
  table([
    { title: 'Department', key: 'department', w: 252 }, { title: 'Open', key: 'open', w: 80 }, { title: 'Assigned', key: 'assigned', w: 80 },
    { title: 'In progress', key: 'in_progress', w: 80 }, { title: 'Closed', key: 'closed', w: 80 }, { title: 'Overdue', key: 'overdue', w: 80 },
    { title: 'Total', key: 'total', w: 130 },
  ], [...summary, { department: 'All departments', ...total }]);

  doc.moveDown(1);
  if (doc.y + 60 > bottom) { doc.addPage(); doc.y = 30; }
  doc.font('Helvetica-Bold').fontSize(11).text(`Complaints (${rows.length}${meta.truncated ? `, newest ${PDF_CAP} only - use the Excel download for the full list` : ''})`, left);
  doc.font('Helvetica').fontSize(8).fillColor('#444').text('Descriptions are in the Excel download (they are often written in Hindi).', left).fillColor('black');
  doc.moveDown(0.3);
  table([
    { title: 'Complaint ID', key: 'id', w: 92 }, { title: 'Filed', key: 'filed', w: 92 }, { title: 'Category', key: 'cat', w: 120 },
    { title: 'Department', key: 'dept', w: 140 }, { title: 'Status', key: 'status', w: 62 }, { title: 'Overdue', key: 'overdue', w: 42 },
    { title: 'Officer', key: 'officer', w: 100 }, { title: 'Closed', key: 'closed', w: 92 }, { title: 'Days', key: 'days', w: 42 },
  ], rows.map((c) => ({
    id: c.complaint_id, filed: fmtTime(c.created_at), cat: c.category_en, dept: c.department_en, status: STATUS_LABEL[c.status],
    overdue: c.overdue ? 'Yes' : '', officer: c.officer_name || '', closed: fmtTime(c.closed_at), days: days(c.created_at, c.closed_at) ?? '',
  })));
  doc.end();
}

export function reportRoutes({ pool }) {
  const r = express.Router();

  const lookups = () => Promise.all([
    pool.query('select category_key, label_en, label_hi from grievance.complaint_categories order by sort'),
    pool.query('select department_id, name_en from grievance.departments order by name_en'),
  ]);

  async function names(f) {
    const [cats, depts] = await lookups();
    return {
      category: (cats.rows.find((c) => c.category_key === f.category) || {}).label_en,
      department: (depts.rows.find((d) => d.department_id === f.department) || {}).name_en,
    };
  }

  r.get('/reports', async (req, res) => {
    const [cats, depts] = await lookups();
    const q = req.query;
    const p = parseFilters(q, req.user);
    // on an error, re-show what was typed so it can be corrected
    const f = p.value || { from: String(q.from || ''), to: String(q.to || ''), status: String(q.status || ''),
      category: String(q.category || ''), department: Number(q.department) || '', overdue: q.overdue === '1' };
    const summary = p.error ? [] : await fetchSummary(pool, req.user, p.value);
    const qs = new URLSearchParams(Object.entries(req.query).filter(([k, v]) => ['from', 'to', 'status', 'category', 'department', 'overdue'].includes(k) && v)).toString();
    res.status(p.error ? 400 : 200).render('reports', {
      title: 'Reports', f, error: p.error || null, summary, qs, categories: cats.rows, departments: depts.rows,
    });
  });

  for (const [ext, cap, write, type] of [
    ['xlsx', XLSX_CAP, writeXlsx, 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet'],
    ['pdf', PDF_CAP, writePdf, 'application/pdf'],
  ]) {
    r.get(`/reports/complaints.${ext}`, async (req, res) => {
      const p = parseFilters(req.query, req.user);
      if (p.error) return res.status(400).render('error', { title: 'Report', message: p.error });
      const f = p.value;
      const [{ rows, truncated }, summary, n] = await Promise.all([fetchRows(pool, req.user, f, cap), fetchSummary(pool, req.user, f), names(f)]);
      // an export of citizen complaint data: always on record
      await audit(pool, req.user.user_id, `report_${ext}`, null, { filters: f, rows: rows.length });
      res.set('Content-Type', type);
      res.set('Content-Disposition', `attachment; filename="complaints-${stamp()}.${ext}"`);
      res.set('Cache-Control', 'private, no-store');
      const meta = { filters: describeFilters(f, n), by: req.user.full_name, truncated };
      return write(res, rows, summary, meta);
    });
  }

  return r;
}
