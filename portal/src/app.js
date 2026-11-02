import path from 'node:path';
import { fileURLToPath } from 'node:url';
import express from 'express';
import session from 'express-session';
import connectPgSimple from 'connect-pg-simple';
import helmet from 'helmet';
import { csrf } from './csrf.js';
import { authRoutes, loadUser, passwordRoutes, requireAuth } from './auth.js';
import { dashboardRoutes } from './routes/dashboard.js';
import { complaintRoutes } from './routes/complaints.js';
import { userRoutes } from './routes/users.js';
import { settingsRoutes } from './routes/settings.js';
import { mediaRoutes } from './routes/media.js';
import { closureRoutes } from './routes/closure.js';
import { reportRoutes } from './routes/reports.js';
import { ROLE_LABEL, STATUS_BADGE, STATUS_LABEL, fmtTime } from './labels.js';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const MODULES = path.join(HERE, '..', 'node_modules');

export function createApp({ pool, config }) {
  const app = express();
  const base = config.basePath;
  app.set('views', path.join(HERE, 'views'));
  app.set('view engine', 'ejs');
  app.set('trust proxy', config.trustProxy);
  app.disable('x-powered-by');
  Object.assign(app.locals, { base, STATUS_LABEL, STATUS_BADGE, ROLE_LABEL, fmtTime });

  app.use(helmet({
    contentSecurityPolicy: {
      directives: {
        'script-src': ["'self'"],
        'img-src': ["'self'", 'data:'],
        // the M6 UAT runs over plain http (SSH tunnel); Cloudflare already forces https once public
        'upgrade-insecure-requests': null,
      },
    },
  }));

  const r = express.Router();
  // static files and health first: no session row per stylesheet request
  r.use('/static/bootstrap', express.static(path.join(MODULES, 'bootstrap', 'dist'), { maxAge: '7d' }));
  r.use('/static/chart', express.static(path.join(MODULES, 'chart.js', 'dist'), { maxAge: '7d' }));
  r.use('/static', express.static(path.join(HERE, 'public'), { maxAge: '1h' }));
  r.get('/healthz', async (req, res) => {
    await pool.query('select 1');
    res.json({ ok: true });
  });

  const PgStore = connectPgSimple(session);
  const store = new PgStore({
    pool, schemaName: 'grievance', tableName: 'portal_sessions', createTableIfMissing: false,
    pruneSessionInterval: config.isTest ? false : 15 * 60,
  });
  app.locals.sessionStore = store;
  r.use(express.urlencoded({ extended: false, limit: '20kb' }));
  r.use(session({
    name: 'portal.sid',
    store,
    secret: config.sessionSecret,
    resave: false,
    saveUninitialized: false,
    rolling: true, // 8 h idle timeout
    cookie: { path: base, httpOnly: true, sameSite: 'lax', secure: config.secureCookie, maxAge: 8 * 3600 * 1000 },
  }));
  r.use(loadUser(pool));
  r.use(csrf);
  r.use((req, res, next) => {
    res.locals.flash = req.session.flash || null;
    delete req.session.flash;
    res.locals.path = req.path;
    next();
  });

  r.use(authRoutes({ pool, config }));
  r.use(requireAuth(base));
  r.use(passwordRoutes({ pool, config }));
  r.use(dashboardRoutes({ pool, config }));
  r.use(complaintRoutes({ pool, config }));
  r.use(closureRoutes({ pool, config }));
  r.use(reportRoutes({ pool, config }));
  r.use(mediaRoutes({ pool, config }));
  r.use(userRoutes({ pool, config }));
  r.use(settingsRoutes({ pool, config }));

  app.use(base, r);
  app.get('/', (req, res) => res.redirect(`${base}/`));
  app.use((req, res) => res.status(404).render('error', { title: 'Not found', message: 'This page does not exist.' }));
  // eslint-disable-next-line no-unused-vars
  app.use((err, req, res, next) => {
    console.error(err);
    res.status(500).render('error', { title: 'Something went wrong', message: 'Please try again. If it keeps happening, tell the district admin.' });
  });
  return app;
}
