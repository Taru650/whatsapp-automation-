#!/usr/bin/env node
// Generate n8n/workflows/**.json from n8n/src. Run after changing anything in n8n/src.
//   node scripts/build_workflows.mjs          write the JSON files
//   node scripts/build_workflows.mjs --check  exit 1 if the committed JSON is stale
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import vm from 'node:vm';
import * as core from '../n8n/src/workflows/core.mjs';
import * as services from '../n8n/src/workflows/services.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const OUT = path.join(ROOT, 'n8n', 'workflows');
const targets = {
  'core/core-00-router.json': core.router,
  'core/core-01-send.json': core.send,
  'core/core-02-llm.json': core.llm,
  'core/core-03-admin-alert.json': core.alert,
  'core/core-04-health.json': core.health,
  'core/core-08-error.json': core.error,
  'core/core-99-test-harness.json': core.harness,
  'services/svc-echo.json': services.echo,
  'services/svc-template.json': services.template,
  'services/svc-mela.json': services.mela,
  'services/sync-mela.json': services.syncMela,
};

// Compile every Code node the way n8n runs it (the body of an async function).
// Catches syntax errors and clashing top-level names between inlined modules
// at build time instead of at the first citizen's message.
function compileCheck(rel, wf) {
  for (const n of wf.nodes.filter((x) => x.type === 'n8n-nodes-base.code')) {
    try {
      new vm.Script(`(async function () {\n${n.parameters.jsCode}\n})`, { filename: `${rel}#${n.name}` });
    } catch (e) {
      console.error(`${rel} / node "${n.name}": ${e.message}`);
      process.exitCode = 1;
    }
  }
}

const check = process.argv.includes('--check');
let stale = 0;
for (const [rel, build] of Object.entries(targets)) {
  const file = path.join(OUT, rel);
  const wf = build().toJSON();
  compileCheck(rel, wf);
  const json = JSON.stringify(wf, null, 2) + '\n';
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
