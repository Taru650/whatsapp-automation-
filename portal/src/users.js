import crypto from 'node:crypto';
import bcrypt from 'bcryptjs';

export const MIN_PASSWORD = 10;
const USERNAME = /^[a-z0-9._-]{3,32}$/;

export function hashPassword(password, rounds) {
  return bcrypt.hash(password, rounds);
}

export function checkPassword(password, hash) {
  return bcrypt.compare(password, hash);
}

// Compared against when the username doesn't exist, so a wrong username takes
// as long as a wrong password (no user enumeration by timing).
export const DUMMY_HASH = bcrypt.hashSync('not-a-real-password', 10);

export function temporaryPassword() {
  // no 0/O/1/l/I: it gets read out over the phone
  const alphabet = 'abcdefghjkmnpqrstuvwxyzABCDEFGHJKLMNPQRSTUVWXYZ23456789';
  const bytes = crypto.randomBytes(12);
  return Array.from(bytes, (b) => alphabet[b % alphabet.length]).join('');
}

export function passwordProblem(password) {
  if (typeof password !== 'string' || password.length < MIN_PASSWORD) return `Password must be at least ${MIN_PASSWORD} characters.`;
  if (password.length > 200) return 'Password is too long.';
  return null;
}

// Returns { value } or { error } for a new account's fields.
export function validateNewUser(body) {
  const username = String(body.username || '').trim().toLowerCase();
  const fullName = String(body.full_name || '').trim();
  if (!USERNAME.test(username)) return { error: 'Username: 3-32 characters, lower-case letters, digits, dot, dash or underscore.' };
  if (fullName.length < 2 || fullName.length > 80) return { error: 'Full name must be 2-80 characters.' };
  const pw = passwordProblem(body.password);
  if (pw) return { error: pw };
  return { value: { username, fullName, password: body.password } };
}

// Who may create/disable/reset whom. district_admin manages everyone;
// a dept_head manages only field officers of their own department.
export function canManage(actor, target) {
  if (!actor || !target || actor.user_id === target.user_id) return false;
  if (actor.role === 'district_admin') return true;
  return actor.role === 'dept_head' && target.role === 'field_officer' && target.department_id === actor.department_id;
}

export function creatableRoles(actor) {
  if (actor.role === 'district_admin') return ['district_admin', 'dept_head', 'field_officer'];
  if (actor.role === 'dept_head') return ['field_officer'];
  return [];
}
