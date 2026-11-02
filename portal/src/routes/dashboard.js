import express from 'express';
import { STATUSES, STATUS_LABEL } from '../labels.js';

export function dashboardRoutes({ pool }) {
  const r = express.Router();

  r.get('/', async (req, res) => {
    const uid = req.user.user_id;
    const [byStatus, overdue, byCategory, recent] = await Promise.all([
      pool.query('select status, count(*)::int as n from grievance.complaints_visible_to($1) group by status', [uid]),
      pool.query(`select count(*)::int as n from grievance.complaints_visible_to($1)
                  where due_at < now() and status not in ('resolved', 'closed')`, [uid]),
      pool.query(`select cat.label_en, count(*)::int as n from grievance.complaints_visible_to($1) c
                  join grievance.complaint_categories cat on cat.category_key = c.category_key
                  where c.status not in ('resolved', 'closed')
                  group by cat.label_en order by n desc, cat.label_en limit 11`, [uid]),
      pool.query(`select c.complaint_id, c.status, c.created_at, cat.label_en as category_en
                  from grievance.complaints_visible_to($1) c
                  join grievance.complaint_categories cat on cat.category_key = c.category_key
                  where c.status in ('open', 'assigned', 'in_progress')
                  order by c.created_at desc limit 10`, [uid]),
    ]);
    const counts = Object.fromEntries(STATUSES.map((s) => [s, 0]));
    for (const row of byStatus.rows) counts[row.status] = row.n;
    const chart = {
      status: { labels: STATUSES.map((s) => STATUS_LABEL[s]), values: STATUSES.map((s) => counts[s]) },
      category: { labels: byCategory.rows.map((x) => x.label_en), values: byCategory.rows.map((x) => x.n) },
    };
    res.render('dashboard', {
      title: 'Dashboard', counts, overdue: overdue.rows[0].n, recent: recent.rows,
      total: Object.values(counts).reduce((a, b) => a + b, 0), chart,
    });
  });

  return r;
}
