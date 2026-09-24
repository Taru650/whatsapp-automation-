#!/usr/bin/env node
// Generate n8n/workflows/**.json from n8n/src. Run after changing anything in n8n/src.
//   node scripts/build_workflows.mjs          write the JSON files
//   node scripts/build_workflows.mjs --check  exit 1 if the committed JSON is stale
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import * as core from '../n8n/src/workflows/core.mjs';
import * as services from '../n8n/src/workflows/services.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const OUT = path.join(ROOT, 'n8n', 'workflows');
const targets = {
  'core/core-00-router.json': core.router,
  'core/core-01-send.json': core.send,
  'core/core-02-llm.json': core.llm,
  'core/core-03-admin-alert.json': core.alert,
  'core/core-08-error.json': core.error,
  'core/core-99-test-harness.json': core.harness,
  'services/svc-echo.json': services.echo,
  'services/svc-template.json': services.template,
};

const check = process.argv.includes('--check');
let stale = 0;
for (const [rel, build] of Object.entries(targets)) {
  const file = path.join(OUT, rel);
  const json = JSON.stringify(build().toJSON(), null, 2) + '\n';
  if (check) {
    const current = fs.existsSync(file) ? fs.readFileSync(file, 'utf8') : '';
    if (current !== json) { console.error(`stale: n8n/workflows/${rel}`); stale++; }
  } else {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, json);
    console.log(`wrote n8n/workflows/${rel}`);
  }
}
if (check && stale) {
  console.error('Run: node scripts/build_workflows.mjs');
  process.exit(1);
}
