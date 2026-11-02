import crypto from 'node:crypto';

// Routes that accept multipart/form-data (file uploads). express.urlencoded
// can't read their body, so the token is checked by the route itself after
// multer has parsed it (verifyCsrf). Every OTHER multipart POST is refused:
// skipping the check for "any multipart request" would let a cross-site
// multipart form hit routes that need no body at all (e.g. disabling a user).
const MULTIPART_ROUTES = [/^\/complaints\/[A-Za-z0-9-]{1,40}\/close$/];

function refuse(res) {
  return res.status(403).render('error', { title: 'Form expired', message: 'This form has expired. Go back, reload the page and try again.' });
}

// Per-session synchronizer token, required on every POST.
export function csrf(req, res, next) {
  if (!req.session.csrf) req.session.csrf = crypto.randomBytes(24).toString('hex');
  res.locals.csrf = req.session.csrf;
  if (req.method !== 'POST') return next();
  if (req.is('multipart/form-data')) return MULTIPART_ROUTES.some((re) => re.test(req.path)) ? next() : refuse(res);
  return verifyCsrf(req, res, next);
}

export function verifyCsrf(req, res, next) {
  const given = String((req.body && req.body._csrf) || '');
  const expected = req.session.csrf || '';
  if (!expected || given.length !== expected.length || !crypto.timingSafeEqual(Buffer.from(given), Buffer.from(expected))) return refuse(res);
  return next();
}
