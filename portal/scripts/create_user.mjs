#!/usr/bin/env node
// Create a portal account from the command line - needed once, for the first
// district admin (everyone else is created in the portal itself).
//
//   docker compose run --rm portal node scripts/create_user.mjs \
//     --role district_admin --username dm.saran --name "District Magistrate"
//
// The password is read from stdin (hidden when typed at a terminal; piping it
// in also works) so it never lands in shell history or `ps`.
// --department <dept_key> is required for dept_head / field_officer.
import { parseArgs } from 'node:util';
import readline from 'node:readline';
import { loadConfig } from '../src/config.js';
import { createPool, audit } from '../src/db.js';
import { ROLES } from '../src/labels.js';
import { hashPassword, validateNewUser } from '../src/users.js';

function readPassword() {
  return new Promise((resolve) => {
    if (!process.stdin.isTTY) {
      let buf = '';
      process.stdin.on('data', (d) => { buf += d; });
      process.stdin.on('end', () => resolve(buf.split('\n')[0]));
      return;
    }
    const rl = readline.createInterface({ input: process.stdin, output: process.stdout, terminal: true });
    rl._writeToOutput = (s) => { if (s.includes('Password')) process.stdout.write(s); };
    rl.question('Password (at least 10 characters): ', (pw) => { rl.close(); process.stdout.write('\n'); resolve(pw); });
  });
}

const { values } = parseArgs({ options: {
  role: { type: 'string' }, username: { type: 'string' }, name: { type: 'string' }, department: { type: 'string' },
} });
if (!ROLES.includes(values.role) || !values.username || !values.name) {
  console.error('usage: create_user.mjs --role district_admin|dept_head|field_officer --username <u> --name "<full name>" [--department <dept_key>]');
  process.exit(2);
}
const v = validateNewUser({ username: values.username, full_name: values.name, password: await readPassword() });
if (v.error) { console.error(v.error); process.exit(2); }

const config = loadConfig({ ...process.env, ENV: process.env.ENV || 'prod', PORTAL_SESSION_SECRET: process.env.PORTAL_SESSION_SECRET || 'x'.repeat(32) });
const pool = createPool(config.db);
try {
  let deptId = null;
  if (values.role !== 'district_admin') {
    const { rows } = await pool.query('select department_id from grievance.departments where dept_key = $1', [values.department || '']);
    if (!rows[0]) { console.error('--department must be a dept_key, e.g. phed, police, veterinary'); process.exit(2); }
    deptId = rows[0].department_id;
  }
  const { rows } = await pool.query(
    `insert into grievance.portal_users (username, password_hash, full_name, role, department_id)
     values ($1, $2, $3, $4, $5) returning user_id`,
    [v.value.username, await hashPassword(v.value.password, config.bcryptRounds), v.value.fullName, values.role, deptId]);
  await audit(pool, null, 'user_create_cli', rows[0].user_id, { username: v.value.username, role: values.role });
  console.log(`created ${values.role} ${v.value.username} (user_id ${rows[0].user_id})`);
} catch (e) {
  console.error(e.code === '23505' ? 'that username already exists' : e.message);
  process.exitCode = 1;
} finally {
  await pool.end();
}
