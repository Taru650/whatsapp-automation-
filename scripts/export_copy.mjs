#!/usr/bin/env node
// Export every citizen-facing string (English + Hindi) for a native-speaker review:
//   node scripts/export_copy.mjs > data/review/hindi_copy_review.csv
// Sources: core.templates (via psql) and the bilingual strings in n8n/src/services/*.js.
import fs from 'node:fs';
import { execFileSync } from 'node:child_process';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const rows = [];
const csv = (v) => `"${String(v ?? '').replace(/"/g, '""').replace(/\n/g, '\\n')}"`;

const t = JSON.parse(execFileSync('psql', ['-X', '-At', '-c',
  "select coalesce(json_agg(json_build_object('key', key, 'en', en, 'hi', hi) order by key), '[]') from core.templates"], { encoding: 'utf8' }));
for (const r of t) rows.push(['core template', r.key, r.en, r.hi]);

const { MELA_LABELS } = require('../n8n/src/services/mela.js');
for (const [k, v] of Object.entries(MELA_LABELS)) {
  rows.push(['mela category', k, v.en, v.hi]);
  rows.push(['mela category (one)', k, v.one.en, v.one.hi]);
}
const src = fs.readFileSync(new URL('../n8n/src/services/mela.js', import.meta.url), 'utf8');
const STR = String.raw`(?:'((?:\\.|[^'\\])*)'|"((?:\\.|[^"\\])*)"|\x60((?:\\.|[^\x60\\])*)\x60)`;
const re = new RegExp(String.raw`melaT\(\s*\w+,\s*` + STR + String.raw`\s*,\s*` + STR, 'gs');
let m;
while ((m = re.exec(src))) {
  const en = m[1] ?? m[2] ?? m[3];
  const hi = m[4] ?? m[5] ?? m[6];
  const line = src.slice(0, m.index).split('\n').length;
  rows.push(['mela screen', `mela.js:${line}`, en, hi]);
}
console.log(['where', 'key', 'english', 'hindi', 'ok (Y/N)', 'better hindi', 'reviewer'].map(csv).join(','));
for (const r of rows) console.log([...r, '', '', ''].map(csv).join(','));
console.error(`${rows.length} strings exported`);
