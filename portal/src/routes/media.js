import path from 'node:path';
import fs from 'node:fs';
import express from 'express';

const SERVABLE = new Set(['image/jpeg', 'image/png', 'application/pdf']);

export function mediaRoutes({ pool, config }) {
  const r = express.Router();
  const root = path.resolve(config.mediaPath);

  r.get('/media/:id', async (req, res) => {
    const id = Number(req.params.id);
    const missing = () => res.status(404).render('error', { title: 'Not found', message: 'No such file.' });
    if (!Number.isSafeInteger(id) || id < 1) return missing();
    const { rows } = await pool.query(
      `select e.file_path, e.mime_type from grievance.complaint_evidence e
       where e.id = $2 and e.complaint_id in (select complaint_id from grievance.complaints_visible_to($1))`,
      [req.user.user_id, id]);
    const e = rows[0];
    if (!e || !SERVABLE.has(e.mime_type)) return missing();
    // file_path comes from the DB, but never trust it to stay inside the media volume
    const full = path.resolve(root, e.file_path);
    if (!full.startsWith(root + path.sep) || !fs.existsSync(full)) return missing();
    res.set('Cache-Control', 'private, max-age=3600');
    res.set('Content-Disposition', 'inline');
    res.type(e.mime_type);
    return res.sendFile(full);
  });

  return r;
}
