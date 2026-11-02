import express from 'express';
import { audit } from '../db.js';
import { requireRole } from '../auth.js';
import { canManage, creatableRoles, hashPassword, temporaryPassword, validateNewUser } from '../users.js';

export function userRoutes({ pool, config }) {
  const r = express.Router();
  const base = config.basePath;
  r.use('/users', requireRole('district_admin', 'dept_head'));

  const departments = () => pool.query('select department_id, name_en, name_hi from grievance.departments where enabled order by name_en');
  const forbidden = (res) => res.status(403).render('error', { title: 'Not allowed', message: 'You cannot manage this account.' });

  async function loadTarget(id) {
    if (!Number.isSafeInteger(id) || id < 1) return null;
    const { rows } = await pool.query('select user_id, username, full_name, role, department_id, enabled from grievance.portal_users where user_id = $1', [id]);
    return rows[0] || null;
  }

  r.get('/users', async (req, res) => {
    const u = req.user;
    const { rows } = u.role === 'district_admin'
      ? await pool.query(`select p.*, d.name_en as department_en from grievance.portal_users p
                          left join grievance.departments d on d.department_id = p.department_id
                          order by p.role, d.name_en nulls first, p.full_name`)
      : await pool.query(`select p.*, d.name_en as department_en from grievance.portal_users p
                          left join grievance.departments d on d.department_id = p.department_id
                          where p.role = 'field_officer' and p.department_id = $1 order by p.full_name`, [u.department_id]);
    res.render('users', { title: 'Staff accounts', users: rows.map((x) => ({ ...x, manageable: canManage(u, x) })) });
  });

  const renderNew = async (req, res, error, form = {}, status = 200) => res.status(status).render('user_new', {
    title: 'New account', error, form, roles: creatableRoles(req.user), departments: (await departments()).rows,
  });

  r.get('/users/new', (req, res) => renderNew(req, res, null));

  r.post('/users/new', async (req, res) => {
    const u = req.user;
    const form = { username: req.body.username, full_name: req.body.full_name, role: req.body.role, department_id: req.body.department_id };
    const v = validateNewUser(req.body);
    if (v.error) return renderNew(req, res, v.error, form, 400);
    const role = String(req.body.role || '');
    if (!creatableRoles(u).includes(role)) return renderNew(req, res, 'You cannot create an account with that role.', form, 403);
    let deptId = null;
    if (role !== 'district_admin') {
      deptId = u.role === 'dept_head' ? u.department_id : Number(req.body.department_id);
      if (!Number.isSafeInteger(deptId) || deptId < 1) return renderNew(req, res, 'Choose a department.', form, 400);
      const { rows } = await pool.query('select 1 from grievance.departments where department_id = $1 and enabled', [deptId]);
      if (!rows[0]) return renderNew(req, res, 'Choose an active department.', form, 400);
    }
    try {
      // must_change_password: the creator knows this first password
      const { rows } = await pool.query(
        `insert into grievance.portal_users (username, password_hash, full_name, role, department_id, created_by_user_id, must_change_password)
         values ($1, $2, $3, $4, $5, $6, true) returning user_id`,
        [v.value.username, await hashPassword(v.value.password, config.bcryptRounds), v.value.fullName, role, deptId, u.user_id]);
      await audit(pool, u.user_id, 'user_create', rows[0].user_id, { username: v.value.username, role, department_id: deptId });
    } catch (e) {
      if (e.code === '23505') return renderNew(req, res, 'That username is already taken.', form, 400);
      throw e;
    }
    req.session.flash = { type: 'success', text: `Account ${v.value.username} created. They must choose a new password when they first sign in.` };
    return res.redirect(`${base}/users`);
  });

  for (const [action, enabled] of [['disable', false], ['enable', true]]) {
    r.post(`/users/:id/${action}`, async (req, res) => {
      const target = await loadTarget(Number(req.params.id));
      if (!canManage(req.user, target)) return forbidden(res);
      await pool.query('update grievance.portal_users set enabled = $2 where user_id = $1', [target.user_id, enabled]);
      await audit(pool, req.user.user_id, `user_${action}`, target.user_id);
      req.session.flash = { type: 'success', text: `${target.full_name} ${enabled ? 'enabled' : 'disabled'}.` };
      return res.redirect(`${base}/users`);
    });
  }

  r.post('/users/:id/reset-password', async (req, res) => {
    const target = await loadTarget(Number(req.params.id));
    if (!canManage(req.user, target)) return forbidden(res);
    const temp = temporaryPassword();
    await pool.query('update grievance.portal_users set password_hash = $2, must_change_password = true where user_id = $1',
      [target.user_id, await hashPassword(temp, config.bcryptRounds)]);
    await audit(pool, req.user.user_id, 'user_reset_password', target.user_id);
    // shown once, never stored in the session or logs
    return res.render('password_reset', { title: 'Temporary password', target, temp });
  });

  return r;
}
