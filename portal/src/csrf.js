import crypto from 'node:crypto';

// Per-session synchronizer token, required on every POST.
export function csrf(req, res, next) {
  if (!req.session.csrf) req.session.csrf = crypto.randomBytes(24).toString('hex');
  res.locals.csrf = req.session.csrf;
  if (req.method !== 'POST') return next();
  const given = String((req.body && req.body._csrf) || '');
  const expected = req.session.csrf;
  if (given.length !== expected.length || !crypto.timingSafeEqual(Buffer.from(given), Buffer.from(expected))) {
    return res.status(403).render('error', { title: 'Form expired', message: 'This form has expired. Go back, reload the page and try again.' });
  }
  return next();
}
