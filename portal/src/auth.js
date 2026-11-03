import express from 'express';
import { rateLimit, ipKeyGenerator } from 'express-rate-limit';
import { audit } from './db.js';
import { checkPassword, DUMMY_HASH, hashPassword, passwordProblem } from './users.js';

// Re-read the user row on every request: disabling an account (or changing its
// role/department) takes effect on that user's very next click, no session
// revocation list needed.
export function loadUser(pool) {
  return async (req, res, next) => {
    req.user = null;
    if (req.session.userId) {
      const { rows } = await pool.query(
        `select u.user_id, u.username, u.full_name, u.role, u.department_id, u.enabled, u.must_change_password,
                d.name_en as department_en, d.name_hi as department_hi
         from grievance.portal_users u left join grievance.departments d on d.department_id = u.department_id
         where u.user_id = $1`, [req.session.userId]);
      if (rows[0] && rows[0].enabled) req.user = rows[0];
      else delete req.session.userId;
    }
    res.locals.user = req.user;
    next();
  };
}

export function requireAuth(base) {
  return (req, res, next) => {
    if (!req.user) return res.redirect(`${base}/login`);
    if (req.user.must_change_password && req.path !== '/password' && req.path !== '/logout') return res.redirect(`${base}/password`);
    return next();
  };
}

export function requireRole(...roles) {
  return (req, res, next) => {
    if (req.user && roles.includes(req.user.role)) return next();
    return res.status(403).render('error', { title: 'Not allowed', message: 'Your account does not have access to this page.' });
  };
}

export function authRoutes({ pool, config }) {
  const r = express.Router();
  const base = config.basePath;

  const loginLimiter = rateLimit({
    windowMs: 15 * 60 * 1000,
    limit: config.loginLimit,
    skipSuccessfulRequests: true,
    standardHeaders: 'draft-8',
    legacyHeaders: false,
    keyGenerator: (req) => `${ipKeyGenerator(req.ip)}|${String((req.body && req.body.username) || '').trim().toLowerCase()}`,
    handler: (req, res) => res.status(429).render('login', { title: 'Sign in', error: 'Too many attempts. Wait 15 minutes and try again.', username: '' }),
  });

  r.get('/login', (req, res) => {
    if (req.user) return res.redirect(`${base}/`);
    return res.render('login', { title: 'Sign in', error: null, username: '' });
  });

  r.post('/login', loginLimiter, async (req, res) => {
    const username = String(req.body.username || '').trim().toLowerCase();
    const password = String(req.body.password || '');
    const { rows } = await pool.query(
      'select user_id, password_hash, enabled from grievance.portal_users where username = $1', [username]);
    const u = rows[0];
    const ok = await checkPassword(password, u ? u.password_hash : DUMMY_HASH);
    if (!u || !ok || !u.enabled) {
      // one message for every failure: never reveal which part was wrong
      return res.status(401).render('login', { title: 'Sign in', error: 'Wrong username or password.', username });
    }
    await new Promise((resolve, reject) => req.session.regenerate((e) => (e ? reject(e) : resolve())));
    req.session.userId = u.user_id;
    await pool.query('update grievance.portal_users set last_login_at = now() where user_id = $1', [u.user_id]);
    await audit(pool, u.user_id, 'login', null);
    return res.redirect(`${base}/`);
  });

  r.post('/logout', (req, res) => {
    req.session.destroy(() => res.redirect(`${base}/login`));
  });

  return r;
}

export function passwordRoutes({ pool, config }) {
  const r = express.Router();
  const base = config.basePath;
  const render = (res, error, status = 200) => res.status(status).render('password', { title: 'Change password', error });

  r.get('/password', (req, res) => render(res, null));

  r.post('/password', async (req, res) => {
    const { current, password, confirm } = req.body;
    const { rows } = await pool.query('select password_hash from grievance.portal_users where user_id = $1', [req.user.user_id]);
    if (!(await checkPassword(String(current || ''), rows[0].password_hash))) return render(res, 'Your current password is wrong.', 400);
    const problem = passwordProblem(password);
    if (problem) return render(res, problem, 400);
    if (password !== confirm) return render(res, 'The two new passwords do not match.', 400);
    if (password === current) return render(res, 'Choose a password different from the current one.', 400);
    await pool.query('update grievance.portal_users set password_hash = $2, must_change_password = false where user_id = $1',
      [req.user.user_id, await hashPassword(password, config.bcryptRounds)]);
    await audit(pool, req.user.user_id, 'password_changed', req.user.user_id);
    req.session.flash = { type: 'success', text: 'Password changed.' };
    return res.redirect(`${base}/`);
  });

  return r;
}
