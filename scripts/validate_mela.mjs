#!/usr/bin/env node
// Show what the sync would accept/reject for a Mela sheet dump (JSON of tabs).
//   node scripts/validate_mela.mjs tests/fixtures/mela_sheet.json [--prod]
import fs from 'node:fs';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { validateMelaSheet } = require('../n8n/src/services/mela_sheet.js');
const file = process.argv[2] || 'tests/fixtures/mela_sheet.json';
const prod = process.argv.includes('--prod');
const today = new Date(Date.now() + 5.5 * 3600e3).toISOString().slice(0, 10);
const r = validateMelaSheet(JSON.parse(fs.readFileSync(file, 'utf8')), { requireVerified: prod, rejectPlaceholders: prod, today });
for (const e of r.errors) console.log(`ERROR    ${e.tab} row ${e.row}: ${e.msg}`);
for (const w of r.warnings) console.log(`warning  ${w.tab} row ${w.row}: ${w.msg}`);
console.log(r.errors.length ? `\nREJECTED: ${r.errors.length} error(s) - the bot would keep its previous data` : `\nOK: ${JSON.stringify(r.counts)}`);
process.exit(r.errors.length ? 1 : 0);
