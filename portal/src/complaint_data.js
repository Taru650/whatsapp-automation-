// Complaint queries shared by the complaint, closure and report routes. Every
// one goes through grievance.complaints_visible_to(user): a complaint outside
// the user's scope simply doesn't exist for them.
import { canClose, canStart, canTransfer, statusAfterAssign } from './transitions.js';

export const ID = /^[A-Za-z0-9-]{1,40}$/;

export const BASE_SELECT = `
  select c.*, cat.label_en as category_en, cat.label_hi as category_hi,
         d.name_en as department_en, d.name_hi as department_hi,
         o.full_name as officer_name,
         (c.due_at < now() and c.status not in ('resolved', 'closed')) as overdue
  from grievance.complaints_visible_to($1) c
  join grievance.complaint_categories cat on cat.category_key = c.category_key
  join grievance.departments d on d.department_id = c.department_id
  left join grievance.portal_users o on o.user_id = c.assigned_officer_user_id`;

// Lock one complaint for update, but only if the user may see it.
export async function lockVisible(client, userId, id) {
  const { rows } = await client.query(
    `select c.* from grievance.complaints c
     where c.complaint_id = $2 and c.complaint_id in (select complaint_id from grievance.complaints_visible_to($1))
     for update of c`, [userId, id]);
  return rows[0] || null;
}

// Everything the complaint page shows, or null if it isn't visible to the user.
export async function loadDetail(pool, u, id) {
  if (!ID.test(id)) return null;
  const { rows } = await pool.query(`${BASE_SELECT} where c.complaint_id = $2`, [u.user_id, id]);
  const c = rows[0];
  if (!c) return null;
  const [evidence, history, officers, departments] = await Promise.all([
    pool.query(`select e.id, e.uploaded_by, e.mime_type, e.kind, e.ts, p.full_name
                from grievance.complaint_evidence e left join grievance.portal_users p on p.user_id = e.uploaded_by_user_id
                where e.complaint_id = $1 order by e.ts, e.id`, [c.complaint_id]),
    pool.query(`select h.*, p.full_name from grievance.complaint_status_history h
                left join grievance.portal_users p on p.user_id = h.changed_by_user_id
                where h.complaint_id = $1 order by h.ts, h.id`, [c.complaint_id]),
    ['district_admin', 'dept_head'].includes(u.role)
      ? pool.query(`select user_id, full_name from grievance.portal_users
                    where role = 'field_officer' and enabled and department_id = $1 order by full_name`, [c.department_id])
      : { rows: [] },
    u.role === 'district_admin'
      ? pool.query('select department_id, name_en from grievance.departments where enabled order by name_en')
      : { rows: [] },
  ]);
  const closure = c.status === 'closed' ? history.rows.filter((h) => h.to_status === 'closed').at(-1) || null : null;
  return {
    title: c.complaint_id, c, history: history.rows, closure,
    citizenEvidence: evidence.rows.filter((e) => e.uploaded_by === 'citizen'),
    officerEvidence: evidence.rows.filter((e) => e.uploaded_by === 'officer'),
    officers: officers.rows, departments: departments.rows,
    can: {
      assign: ['district_admin', 'dept_head'].includes(u.role) && statusAfterAssign(c.status) !== null,
      start: canStart(c.status),
      transfer: u.role === 'district_admin' && canTransfer(c.status),
      close: canClose(c.status),
    },
    closeError: null, closeRemark: '',
  };
}
