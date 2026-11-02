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
    // 0 while the portal is reached directly (M6, localhost/Tailscale); set to the
    // number of proxies in front of it once public (M9: Cloudflare + Caddy).
    trustProxy: Number(env.PORTAL_TRUST_PROXY || 0),
    // localhost counts as a secure context, so Secure cookies work over an SSH tunnel too
    secureCookie: !isTest && env.PORTAL_INSECURE_COOKIE !== 'true',
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
