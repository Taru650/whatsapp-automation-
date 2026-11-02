import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import express from 'express';
import multer from 'multer';
import { audit, tx } from '../db.js';
import { verifyCsrf } from '../csrf.js';
import { ID, loadDetail, lockVisible } from '../complaint_data.js';
import { canClose } from '../transitions.js';

export const MAX_PHOTOS = 5;
export const MAX_PHOTO_BYTES = 10 * 1024 * 1024;

// The browser's declared type is just a claim; look at the bytes.
export function photoType(buf) {
  if (buf.length > 3 && buf[0] === 0xff && buf[1] === 0xd8 && buf[2] === 0xff) return { mime: 'image/jpeg', ext: 'jpg' };
  if (buf.length > 8 && buf.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))) return { mime: 'image/png', ext: 'png' };
  return null;
}

const UPLOAD_ERRORS = {
  LIMIT_FILE_SIZE: `Each photo must be under ${MAX_PHOTO_BYTES / 1024 / 1024} MB.`,
  LIMIT_FILE_COUNT: `Attach at most ${MAX_PHOTOS} photos.`,
  LIMIT_UNEXPECTED_FILE: `Attach at most ${MAX_PHOTOS} photos.`,
};

export function closureRoutes({ pool, config }) {
  const r = express.Router();
  const base = config.basePath;
  const root = path.resolve(config.mediaPath);
  const upload = multer({
    storage: multer.memoryStorage(),
    limits: { fileSize: MAX_PHOTO_BYTES, files: MAX_PHOTOS, fields: 5, fieldSize: 8 * 1024, parts: MAX_PHOTOS + 5 },
  }).array('photos', MAX_PHOTOS);

  const notFound = (res) => res.status(404).render('error', { title: 'Not found', message: 'No such complaint, or it is not in your area of work.' });

  // Re-show the complaint page with the error next to the form, keeping the typed remark.
  async function refuse(req, res, message) {
    const detail = await loadDetail(pool, req.user, req.params.id);
    if (!detail) return notFound(res);
    return res.status(400).render('complaint', { ...detail, closeError: message, closeRemark: String((req.body && req.body.remark) || '').slice(0, 1000) });
  }

  const parse = (req, res, next) => upload(req, res, (err) => {
    if (!err) return next();
    if (err instanceof multer.MulterError) {
      req.body = req.body || {};
      return verifyCsrf(req, res, () => refuse(req, res, UPLOAD_ERRORS[err.code] || 'The upload could not be read. Try again.'));
    }
    return next(err);
  });

  r.post('/complaints/:id/close', parse, verifyCsrf, async (req, res) => {
    const u = req.user;
    if (!ID.test(req.params.id)) return notFound(res);
    const remark = String(req.body.remark || '').trim();
    const files = req.files || [];
    if (remark.length < 5 || remark.length > 1000) return refuse(req, res, 'Describe what was done (at least 5 characters).');
    if (!files.length) return refuse(req, res, 'Attach at least one photo of the completed work.');
    const photos = [];
    for (const f of files) {
      const type = photoType(f.buffer);
      if (!type) return refuse(req, res, `"${f.originalname}" is not a JPG or PNG photo.`);
      photos.push({ ...type, buffer: f.buffer, sha256: crypto.createHash('sha256').update(f.buffer).digest('hex') });
    }

    const written = [];
    let result;
    try {
      result = await tx(pool, async (db) => {
        const c = await lockVisible(db, u.user_id, req.params.id);
        if (!c) return { notFound: true };
        if (!canClose(c.status)) return { error: c.status === 'closed' ? 'This complaint is already closed.' : 'Only an assigned or in-progress complaint can be closed.' };
        // the trigger in sql/30_grievance.sql checks for this remark and an officer
        // photo, so both go in before the status changes
        await db.query(`insert into grievance.complaint_status_history (complaint_id, from_status, to_status, changed_by_user_id, remark)
                        values ($1, $2, 'closed', $3, $4)`, [c.complaint_id, c.status, u.user_id, remark]);
        const seen = new Set();
        for (const p of photos) {
          if (seen.has(p.sha256)) continue; // the same photo picked twice
          seen.add(p.sha256);
          const rel = path.posix.join('officer', c.complaint_id, `${p.sha256}.${p.ext}`);
          const full = path.join(root, rel);
          if (!fs.existsSync(full)) {
            fs.mkdirSync(path.dirname(full), { recursive: true });
            fs.writeFileSync(full, p.buffer);
            written.push(full);
          }
          await db.query(`insert into grievance.complaint_evidence (complaint_id, uploaded_by, uploaded_by_user_id, file_path, mime_type, kind, sha256)
                          values ($1, 'officer', $2, $3, $4, 'photo', $5)`, [c.complaint_id, u.user_id, rel, p.mime, p.sha256]);
        }
        await db.query(`update grievance.complaints set status = 'closed', closed_at = now(), updated_at = now() where complaint_id = $1`, [c.complaint_id]);
        await audit(db, u.user_id, 'close', c.complaint_id, { photos: seen.size });
        return { ok: true };
      });
    } catch (e) {
      for (const f of written) fs.rmSync(f, { force: true }); // no orphan files when nothing was recorded
      throw e;
    }
    if (result.notFound) return notFound(res);
    if (result.error) return refuse(req, res, result.error);
    req.session.flash = { type: 'success', text: 'Complaint closed with your proof.' };
    return res.redirect(`${base}/complaints/${encodeURIComponent(req.params.id)}`);
  });

  return r;
}
