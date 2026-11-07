import express from 'express';
import { requireRole } from '../auth.js';
import { topicLabel } from '../labels.js';

export const USAGE_PERIODS = [7, 14, 30];

// Every day of the period, oldest first, with zeros for days nobody wrote.
function fillDays(from, days, rows) {
  const byDay = new Map(rows.map((r) => [String(r.day).slice(0, 10), r]));
  const out = [];
  const start = new Date(`${String(from).slice(0, 10)}T00:00:00Z`);
  for (let i = 0; i < days; i++) {
    const d = new Date(start.getTime() + i * 86400000).toISOString().slice(0, 10);
    const r = byDay.get(d) || {};
    out.push({ day: d, citizens: r.citizens || 0, new_citizens: r.new_citizens || 0, messages: r.messages || 0,
      answered_pct: r.answered_pct ?? null, unanswered: r.unanswered || 0, thumbs_up: r.thumbs_up || 0, thumbs_down: r.thumbs_down || 0 });
  }
  return out;
}

// Topic rows are per (service, code); several codes share one plain label.
export function groupTopics(rows) {
  const by = new Map();
  for (const r of rows) {
    const label = topicLabel(r.service_key, r.subtype);
    const g = by.get(label) || { label, service: r.service_key, messages: 0 };
    g.messages += Number(r.messages) || 0;
    by.set(label, g);
  }
  return [...by.values()].sort((a, b) => b.messages - a.messages || a.label.localeCompare(b.label));
}

const DAY_FMT = new Intl.DateTimeFormat('en-IN', { day: '2-digit', month: 'short', timeZone: 'UTC' });

export function usageRoutes({ pool }) {
  const r = express.Router();
  // District admin only: the page, the link in the menu (partials/head.ejs) and
  // grievance.usage_report() itself all check the role.
  r.use('/usage', requireRole('district_admin'));

  r.get('/usage', async (req, res) => {
    const days = USAGE_PERIODS.includes(Number(req.query.days)) ? Number(req.query.days) : 14;
    const { rows } = await pool.query('select grievance.usage_report($1, $2) as r', [req.user.user_id, days]);
    const u = rows[0].r;
    const daily = fillDays(u.from, u.days, u.daily || []);
    const topics = groupTopics(u.topics || []);
    const chart = {
      labels: daily.map((d) => DAY_FMT.format(new Date(`${d.day}T00:00:00Z`))),
      citizens: daily.map((d) => d.citizens),
      messages: daily.map((d) => d.messages),
    };
    res.render('usage', {
      title: 'Usage', days, periods: USAGE_PERIODS, totals: u.totals || {}, newCitizens: u.new_citizens || 0,
      complaintsFiled: u.complaints_filed || 0, daily: daily.slice().reverse(), topics: topics.slice(0, 15),
      topicTotal: topics.reduce((a, t) => a + t.messages, 0), unanswered: u.unanswered || [], chart,
      fmtDay: (d) => DAY_FMT.format(new Date(`${String(d).slice(0, 10)}T00:00:00Z`)),
    });
  });

  return r;
}
