import express from 'express';
import { audit, tx } from '../db.js';
import { STATUSES } from '../labels.js';
import { canStart, canTransfer, statusAfterAssign } from '../transitions.js';
import { BASE_SELECT, ID, loadDetail, lockVisible } from '../complaint_data.js';

const PAGE = 50;

function cleanRemark(s) {
  return String(s || '').trim().slice(0, 1000) || null;
}

export function complaintRoutes({ pool, config }) {
  const r = express.Router();
  const base = config.basePath;
  const back = (req, res, id, type, text) => {
    req.session.flash = { type, text };
    return res.redirect(`${base}/complaints/${encodeURIComponent(id)}`);
  };
  const notFound = (res) => res.status(404).render('error', { title: 'Not found', message: 'No such complaint, or it is not in your area of work.' });

  r.get('/complaints', async (req, res) => {
    const u = req.user;
    const where = [];
    const params = [u.user_id];
    const add = (sql, v) => { params.push(v); where.push(sql.replace('?', `$${params.length}`)); };
    const f = {
      status: STATUSES.includes(req.query.status) ? req.query.status : '',
      category: /^[a-z_]{1,40}$/.test(req.query.category || '') ? req.query.category : '',
      department: u.role === 'district_admin' && /^\d{1,6}$/.test(req.query.department || '') ? Number(req.query.department) : '',
      overdue: req.query.overdue === '1',
      q: ID.test(req.query.q || '') ? req.query.q : '',
    };
    if (f.status) add('c.status = ?', f.status);
    if (f.category) add('c.category_key = ?', f.category);
    if (f.department) add('c.department_id = ?', f.department);
    if (f.q) add('c.complaint_id ilike ?', `%${f.q}%`);
    if (f.overdue) where.push("c.due_at < now() and c.status not in ('resolved', 'closed')");
    const page = Math.max(1, Math.min(10000, Number(req.query.page) || 1));
    const { rows } = await pool.query(
      `${BASE_SELECT} ${where.length ? `where ${where.join(' and ')}` : ''}
       order by c.created_at desc limit ${PAGE + 1} offset ${(page - 1) * PAGE}`, params);
    const [cats, depts] = await Promise.all([
      pool.query('select category_key, label_en, label_hi from grievance.complaint_categories order by sort'),
      pool.query('select department_id, name_en from grievance.departments order by name_en'),
    ]);
    res.render('complaints', {
      title: 'Complaints', complaints: rows.slice(0, PAGE), hasMore: rows.length > PAGE, page, f,
      categories: cats.rows, departments: depts.rows,
    });
  });

  r.get('/complaints/:id', async (req, res) => {
    const u = req.user;
    const detail = await loadDetail(pool, u, req.params.id);
    if (!detail) return notFound(res);
    res.render('complaint', detail);
  });

  r.post('/complaints/:id/assign', async (req, res) => {
    const u = req.user;
    if (!['district_admin', 'dept_head'].includes(u.role)) return res.status(403).render('error', { title: 'Not allowed', message: 'Only a department head or the district admin can assign complaints.' });
    if (!ID.test(req.params.id)) return notFound(res);
    const officerId = Number(req.body.officer_id);
    const remark = cleanRemark(req.body.remark);
    if (!Number.isSafeInteger(officerId) || officerId < 1) return back(req, res, req.params.id, 'danger', 'Choose an officer.');
    const result = await tx(pool, async (db) => {
      const c = await lockVisible(db, u.user_id, req.params.id);
      if (!c) return { notFound: true };
      const next = statusAfterAssign(c.status);
      if (!next) return { error: 'This complaint can no longer be assigned.' };
      const { rows } = await db.query(
        `select user_id, full_name from grievance.portal_users
         where user_id = $1 and role = 'field_officer' and enabled and department_id = $2`, [officerId, c.department_id]);
      if (!rows[0]) return { error: 'Choose an active field officer of this department.' };
      await db.query(`update grievance.complaints set assigned_officer_user_id = $2, status = $3, updated_at = now()
                      where complaint_id = $1`, [c.complaint_id, officerId, next]);
      await db.query(`insert into grievance.complaint_status_history (complaint_id, from_status, to_status, changed_by_user_id, remark)
                      values ($1, $2, $3, $4, $5)`, [c.complaint_id, c.status, next, u.user_id,
        `Assigned to ${rows[0].full_name}${remark ? ` - ${remark}` : ''}`]);
      await audit(db, u.user_id, 'assign', c.complaint_id, { officer_id: officerId });
      return { ok: `Assigned to ${rows[0].full_name}.` };
    });
    if (result.notFound) return notFound(res);
    return back(req, res, req.params.id, result.ok ? 'success' : 'danger', result.ok || result.error);
  });

  r.post('/complaints/:id/start', async (req, res) => {
    const u = req.user;
    if (!ID.test(req.params.id)) return notFound(res);
    const remark = cleanRemark(req.body.remark);
    const result = await tx(pool, async (db) => {
      const c = await lockVisible(db, u.user_id, req.params.id);
      if (!c) return { notFound: true };
      if (!canStart(c.status)) return { error: 'Work can only be started on an assigned complaint.' };
      await db.query("update grievance.complaints set status = 'in_progress', updated_at = now() where complaint_id = $1", [c.complaint_id]);
      await db.query(`insert into grievance.complaint_status_history (complaint_id, from_status, to_status, changed_by_user_id, remark)
                      values ($1, $2, 'in_progress', $3, $4)`, [c.complaint_id, c.status, u.user_id, remark || 'Work started']);
      return { ok: 'Marked as in progress.' };
    });
    if (result.notFound) return notFound(res);
    return back(req, res, req.params.id, result.ok ? 'success' : 'danger', result.ok || result.error);
  });

  r.post('/complaints/:id/transfer', async (req, res) => {
    const u = req.user;
    if (u.role !== 'district_admin') return res.status(403).render('error', { title: 'Not allowed', message: 'Only the district admin can move a complaint to another department.' });
    if (!ID.test(req.params.id)) return notFound(res);
    const deptId = Number(req.body.department_id);
    const remark = cleanRemark(req.body.remark);
    if (!Number.isSafeInteger(deptId) || deptId < 1) return back(req, res, req.params.id, 'danger', 'Choose a department.');
    const result = await tx(pool, async (db) => {
      const c = await lockVisible(db, u.user_id, req.params.id);
      if (!c) return { notFound: true };
      if (!canTransfer(c.status)) return { error: 'A resolved or closed complaint cannot be moved.' };
      if (deptId === c.department_id) return { error: 'It is already with that department.' };
      const { rows } = await db.query(
        `select (select name_en from grievance.departments where department_id = $1) as from_name,
                (select name_en from grievance.departments where department_id = $2 and enabled) as to_name`, [c.department_id, deptId]);
      if (!rows[0].to_name) return { error: 'Choose an active department.' };
      await db.query(`update grievance.complaints set department_id = $2, assigned_officer_user_id = null, status = 'open', updated_at = now()
                      where complaint_id = $1`, [c.complaint_id, deptId]);
      await db.query(`insert into grievance.complaint_status_history (complaint_id, from_status, to_status, changed_by_user_id, remark)
                      values ($1, $2, 'open', $3, $4)`, [c.complaint_id, c.status, u.user_id,
        `Moved from ${rows[0].from_name} to ${rows[0].to_name}${remark ? ` - ${remark}` : ''}`]);
      await audit(db, u.user_id, 'transfer', c.complaint_id, { from: c.department_id, to: deptId });
      return { ok: `Moved to ${rows[0].to_name}.` };
    });
    if (result.notFound) return notFound(res);
    return back(req, res, req.params.id, result.ok ? 'success' : 'danger', result.ok || result.error);
  });

  return r;
}
