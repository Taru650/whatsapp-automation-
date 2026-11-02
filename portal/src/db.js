import pg from 'pg';

export function createPool(db) {
  return new pg.Pool({ ...db, max: 10 });
}

// Run fn(client) inside one transaction.
export async function tx(pool, fn) {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const out = await fn(client);
    await client.query('COMMIT');
    return out;
  } catch (e) {
    await client.query('ROLLBACK').catch(() => {});
    throw e;
  } finally {
    client.release();
  }
}

export function audit(db, userId, action, target, detail = {}) {
  return db.query('insert into grievance.portal_audit (user_id, action, target, detail) values ($1, $2, $3, $4)',
    [userId, action, target == null ? null : String(target), detail]);
}
