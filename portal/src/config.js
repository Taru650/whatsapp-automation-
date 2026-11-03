// Portal configuration from the environment (see .env.example, "complaint portal").
export function loadConfig(env = process.env) {
  const isTest = env.ENV === 'test';
  const secret = env.PORTAL_SESSION_SECRET || '';
  if (!isTest && (secret.length < 32 || secret === 'change-me')) {
    throw new Error('PORTAL_SESSION_SECRET must be a long random value (openssl rand -hex 32)');
  }
  return {
    env: env.ENV || 'prod',
    isTest,
    port: Number(env.PORTAL_PORT || 3001),
    basePath: '/portal',
    sessionSecret: secret || 'test-only-session-secret-not-for-production',
    bcryptRounds: Number(env.PORTAL_BCRYPT_ROUNDS || 12),
    mediaPath: env.COMPLAINT_MEDIA_PATH || '/data/complaint-media',
    // Hops in front of the portal whose X-Forwarded-* headers are believed: 1 =
    // Caddy (deploy/Caddyfile hands on exactly one client IP and the original
    // https). Direct access (SSH tunnel to 127.0.0.1:3001) sends no such headers.
    trustProxy: Number(env.PORTAL_TRUST_PROXY ?? 1),
    // 'auto': the cookie is Secure whenever the request came in over https (through
    // Caddy), and plain over a direct http://localhost SSH tunnel. A hard `true`
    // made express-session refuse to set any cookie over plain http, so sign-in
    // through the tunnel always failed with 403 (no session -> no CSRF token).
    secureCookie: isTest ? false : 'auto',
    loginLimit: Number(env.PORTAL_LOGIN_LIMIT || 5),
    db: {
      host: env.PORTAL_DB_HOST || 'postgres',
      port: Number(env.PORTAL_DB_PORT || 5432),
      database: env.PORTAL_DB_NAME || 'citizen_bot',
      user: env.PORTAL_DB_USER || 'portal_rw',
      password: env.PORTAL_DB_PASSWORD,
    },
  };
}
