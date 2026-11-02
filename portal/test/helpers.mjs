// Shared fixtures for the portal tests. They run against the real, migrated
// citizen_bot database as portal_rw (the same least-privilege login the
// portal uses in production), so they also prove the grants are enough.
//   PORTAL_DB_HOST/PORT/PASSWORD  portal_rw connection (default 127.0.0.1 / portaltestpw)
//   PGHOST/PGUSER/PGPASSWORD/...  an admin connection, only for checks portal_rw can't do
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import pg from 'pg';
import request from 'supertest';
import bcrypt from 'bcryptjs';
import { loadConfig } from '../src/config.js';
import { createApp } from '../src/app.js';
import { createPool } from '../src/db.js';

export const PASSWORD = 'correct-horse-battery';

export function setup(extraEnv = {}) {
  const mediaPath = fs.mkdtempSync(path.join(os.tmpdir(), 'portal-media-'));
  const config = loadConfig({
    ENV: 'test',
    PORTAL_DB_HOST: process.env.PORTAL_DB_HOST || '127.0.0.1',
    PORTAL_DB_PORT: process.env.PORTAL_DB_PORT || '5432',
    PORTAL_DB_NAME: process.env.PORTAL_DB_NAME || 'citizen_bot',
    PORTAL_DB_PASSWORD: process.env.PORTAL_DB_PASSWORD || 'portaltestpw',
    PORTAL_BCRYPT_ROUNDS: '4',
    PORTAL_LOGIN_LIMIT: '50',
    COMPLAINT_MEDIA_PATH: mediaPath,
    ...extraEnv,
  });
  const pool = createPool(config.db);
  // supertest can't bind an Express 5 app by itself here; hand it a listening server
  const expressApp = createApp({ pool, config });
  const server = http.createServer(expressApp);
  const ready = new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const app = server;
  const run = `t${Date.now().toString(36)}${Math.floor(Math.random() * 1e4)}`;
  const hash = bcrypt.hashSync(PASSWORD, 4);
  const ids = { users: [], complaints: [] };

  const dept = async (key) => (await pool.query('select department_id from grievance.departments where dept_key = $1', [key])).rows[0].department_id;

  async function user(name, role, deptKey, extra = {}) {
    const { rows } = await pool.query(
      `insert into grievance.portal_users (username, password_hash, full_name, role, department_id, enabled, must_change_password)
       values ($1, $2, $3, $4, $5, $6, $7) returning *`,
      [`${run}_${name}`, extra.hash || hash, `${name} ${run}`, role, deptKey ? await dept(deptKey) : null,
        extra.enabled ?? true, extra.mustChange ?? false]);
    ids.users.push(rows[0].user_id);
    return rows[0];
  }

  async function complaint(suffix, category, deptKey, extra = {}) {
    const id = `${run.toUpperCase()}-${suffix}`;
    await pool.query(
      `insert into grievance.complaints (complaint_id, citizen_wa_hash, category_key, department_id, description, lat, lon, status, assigned_officer_user_id, due_at)
       values ($1, 'h', $2, $3, $4, 25.69, 85.17, $5, $6, now() + interval '3 days')`,
      [id, category, await dept(deptKey), `desc ${suffix}`, extra.status || 'open', extra.officer || null]);
    await pool.query(`insert into grievance.complaint_status_history (complaint_id, to_status, remark) values ($1, 'open', 'registered via WhatsApp')`, [id]);
    ids.complaints.push(id);
    return id;
  }

  async function evidence(complaintId, filePath, mime = 'image/png', write = true) {
    if (write) {
      const full = path.join(mediaPath, filePath);
      fs.mkdirSync(path.dirname(full), { recursive: true });
      fs.writeFileSync(full, Buffer.from('fake-png'));
    }
    const { rows } = await pool.query(
      `insert into grievance.complaint_evidence (complaint_id, uploaded_by, file_path, mime_type, kind)
       values ($1, 'citizen', $2, $3, 'photo') returning id`, [complaintId, filePath, mime]);
    return rows[0].id;
  }

  async function cleanup() {
    await pool.query('delete from grievance.complaints where complaint_id = any($1)', [ids.complaints]);
    await pool.query('delete from grievance.portal_audit where user_id = any($1) or target = any($2)',
      [ids.users, ids.users.map(String)]);
    await pool.query(`delete from grievance.portal_users where username like $1 || '%' and created_by_user_id is not null`, [run]);
    await pool.query(`delete from grievance.portal_users where username like $1 || '%'`, [run]);
    // only this file's sessions: test files may run in parallel
    await pool.query(`delete from grievance.portal_sessions where (sess->>'userId')::bigint = any($1)`, [ids.users]);
    await new Promise((resolve) => server.close(resolve));
    await expressApp.locals.sessionStore.close();
    await pool.end();
    fs.rmSync(mediaPath, { recursive: true, force: true });
  }

  return { app, ready, pool, config, run, user, complaint, evidence, dept, cleanup, mediaPath };
}

export const csrfOf = (html) => (/name="_csrf" value="([a-f0-9]+)"/.exec(html) || [])[1];

export async function login(app, username, password = PASSWORD) {
  const agent = request.agent(app);
  const page = await agent.get('/portal/login');
  const res = await agent.post('/portal/login').type('form').send({ _csrf: csrfOf(page.text), username, password });
  return { agent, res };
}

// The CSRF token of a logged-in session (it changes at login).
export async function tokenOf(agent) {
  return csrfOf((await agent.get('/portal/password')).text);
}

export async function post(agent, url, form = {}) {
  return agent.post(url).type('form').send({ _csrf: await tokenOf(agent), ...form });
}

// Admin connection for checks portal_rw is (deliberately) not allowed to make.
export function adminPool() {
  return new pg.Pool();
}
