import express from 'express';
import { audit, tx } from '../db.js';
import { requireRole } from '../auth.js';

const KEYS = ['geofence_enabled', 'geofence_center_lat', 'geofence_center_lon', 'geofence_radius_m'];

async function readGeofence(pool) {
  const { rows } = await pool.query('select key, value from grievance.settings where key = any($1)', [KEYS]);
  const s = Object.fromEntries(rows.map((r) => [r.key, r.value]));
  return {
    enabled: s.geofence_enabled === true,
    lat: typeof s.geofence_center_lat === 'number' ? s.geofence_center_lat : '',
    lon: typeof s.geofence_center_lon === 'number' ? s.geofence_center_lon : '',
    radius: typeof s.geofence_radius_m === 'number' ? s.geofence_radius_m : 500,
  };
}

// Returns { value } or { error }. Bounds are India's bounding box: a typo
// that swaps lat/lon or drops a digit is rejected instead of silently
// blocking every complaint.
export function validateGeofence(body) {
  const enabled = body.enabled === 'on';
  const lat = body.lat === '' || body.lat == null ? null : Number(body.lat);
  const lon = body.lon === '' || body.lon == null ? null : Number(body.lon);
  const radius = Number(body.radius);
  if ((lat === null) !== (lon === null)) return { error: 'Enter both latitude and longitude, or neither.' };
  if (lat !== null && !(lat >= 6 && lat <= 38)) return { error: 'Latitude must be between 6 and 38 (India).' };
  if (lon !== null && !(lon >= 68 && lon <= 98)) return { error: 'Longitude must be between 68 and 98 (India).' };
  if (!Number.isInteger(radius) || radius < 50 || radius > 20000) return { error: 'Radius must be a whole number of metres between 50 and 20000.' };
  if (enabled && lat === null) return { error: 'Set the centre point before turning the geofence on.' };
  return { value: { enabled, lat, lon, radius } };
}

export function settingsRoutes({ pool, config }) {
  const r = express.Router();
  r.use('/settings', requireRole('district_admin'));

  r.get('/settings/geofence', async (req, res) => {
    res.render('geofence', { title: 'Complaint area (geofence)', g: await readGeofence(pool), error: null });
  });

  r.post('/settings/geofence', async (req, res) => {
    const v = validateGeofence(req.body);
    if (v.error) {
      return res.status(400).render('geofence', {
        title: 'Complaint area (geofence)', error: v.error,
        g: { enabled: req.body.enabled === 'on', lat: req.body.lat, lon: req.body.lon, radius: req.body.radius },
      });
    }
    const g = v.value;
    await tx(pool, async (db) => {
      const put = (k, val) => db.query(
        'insert into grievance.settings (key, value) values ($1, $2::jsonb) on conflict (key) do update set value = excluded.value',
        [k, JSON.stringify(val)]);
      await put('geofence_enabled', g.enabled);
      await put('geofence_center_lat', g.lat);
      await put('geofence_center_lon', g.lon);
      await put('geofence_radius_m', g.radius);
      await audit(db, req.user.user_id, 'geofence', null, g);
    });
    req.session.flash = { type: 'success', text: g.enabled
      ? `Geofence on: complaints only from within ${g.radius} m of ${g.lat}, ${g.lon}. Applies to the next WhatsApp message.`
      : 'Geofence off: complaints accepted from anywhere.' };
    return res.redirect(`${config.basePath}/settings/geofence`);
  });

  return r;
}
