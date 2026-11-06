// Service workflows: a passthrough trigger plus one Code node calling the
// service's handler. The router strips nothing, so drop its private _router key.
import { Workflow, IDS } from './lib.mjs';

function serviceWorkflow(id, name, module, handler) {
  const w = new Workflow(id, name);
  const trig = w.trigger();
  const handle = w.code('Handle', { modules: [module], main: `
const { _router, ...req } = $json;
return { json: ${handler}(req) };
` });
  w.chain(trig, handle);
  return w;
}

export const echo = () => serviceWorkflow(IDS.echo, 'svc-echo', 'services/echo.js', 'echoHandle');
export const template = () => serviceWorkflow(IDS.template, 'svc-template', 'services/template.js', 'templateHandle');

// ---------------------------------------------------------------------------
// svc-mela: load the Mela snapshot -> handle -> (LLM Q&A) -> apply admin effects
// Linear on purpose: a sub-workflow returns its last node's output, so every
// item must end in the same node.
// ---------------------------------------------------------------------------
export function mela() {
  const w = new Workflow(IDS.mela, 'svc-mela');
  const trig = w.trigger();
  const load = w.pg('Load Mela Data',
    "select svc_mela.snapshot() as snap, (select content from svc_mela.qa_context where id = 1) as qa, coalesce((select value from core.settings where key = 'llm_enabled'), 'true') as llm_setting, $1::int as i",
    '={{ [ $itemIndex ] }}');
  const handle = w.code('Handle', { modules: ['services/mela.js'], main: `
const { _router, ...req } = $('When Called').item.json;
const llmOn = String($env.LLM_ENABLED ?? 'true') !== 'false' && String($json.llm_setting) !== 'false';
// AI off -> no "Ask a question" row in the menu (mela.js qaOn)
const snap = { ...($json.snap || {}), qa_enabled: llmOn };
let out = melaHandle(req, snap);
if (out.qa_request) {
  // General question: answer only from the approved Mela text (never invents numbers;
  // the core phone guard double-checks anything that looks like one).
  let resp = { error: { message: 'llm disabled' } };
  if (llmOn) {
    try {
      resp = await this.helpers.httpRequest({
        method: 'POST', url: ($env.ANTHROPIC_BASE_URL || 'https://api.anthropic.com') + '/v1/messages', json: true, timeout: 12000,
        headers: { 'x-api-key': $env.ANTHROPIC_API_KEY, 'anthropic-version': '2023-06-01' },
        body: melaQaRequest(out.qa_request.question, $json.qa, snap, $env.LLM_MODEL),
      });
    } catch (e) {
      resp = { error: { message: String(e.message || e) } };
    }
  }
  out = melaQaFinish(req, snap, resp);
}
return { json: { out, wa_hash: req.wa_hash } };
` });
  const effects = w.pg('Apply Effects', 'select svc_mela.apply_effects($1::jsonb) as r',
    '={{ [ JSON.stringify({ wa_hash: $json.wa_hash, effects: $json.out.effects || [] }) ] }}');
  const ret = w.code('Return', { main: `
const { effects, qa_request, ...out } = $('Handle').item.json.out;
return { json: out };
` });
  w.chain(trig, load, handle, effects, ret);
  return w;
}

// ---------------------------------------------------------------------------
// svc-complaint: load the citizen's snapshot -> download any photo/PDF evidence
// -> handle -> apply effects (creates the complaint + its id) -> real receipt
// Linear on purpose, same reason as svc-mela: a sub-workflow returns its last
// node's output, so every item must end in the same node.
// ---------------------------------------------------------------------------
export function complaint() {
  const w = new Workflow(IDS.complaint, 'svc-complaint');
  const trig = w.trigger();
  const load = w.pg('Load Complaint Data', 'select svc_complaint.snapshot($1) as snap', '={{ [ $json.wa_hash ] }}');
  // Not wired into core-00-router: only this workflow ever downloads media, so
  // the shared router pipeline (and every other service) is untouched.
  const media = w.code('Download Media', { modules: ['core/media.js'], main: `
const req = $('When Called').item.json;
let input = { ...req.input };
if (input.kind === 'image' || input.kind === 'document') {
  const crypto = require('crypto');
  const fs = require('fs');
  const path = require('path');
  const cfg = { base: $env.WA_API_BASE, version: $env.GRAPH_API_VERSION, token: $env.WHATSAPP_ACCESS_TOKEN };
  try {
    const dl = await downloadMedia(input.media_id, input.mime, cfg, this.helpers.httpRequest.bind(this.helpers));
    if (dl.error) {
      input = { ...input, media_error: dl.error + (dl.reason ? ':' + dl.reason : '') };
    } else {
      const sha256 = crypto.createHash('sha256').update(dl.buffer).digest('hex');
      const ext = dl.kind === 'pdf' ? 'pdf' : (dl.mime === 'image/png' ? 'png' : 'jpg');
      const rel = req.wa_hash + '/' + sha256 + '.' + ext;
      const full = path.join($env.COMPLAINT_MEDIA_PATH || '/data/complaint-media', rel);
      fs.mkdirSync(path.dirname(full), { recursive: true });
      fs.writeFileSync(full, dl.buffer);
      input = { ...input, media_path: rel, media_mime: dl.mime, media_kind: dl.kind, media_sha256: sha256 };
    }
  } catch (e) {
    // fs/crypto failure after a good download, e.g. EACCES on the media volume
    input = { ...input, media_error: 'save_failed:' + String((e && (e.code || e.message)) || '').slice(0, 40) };
  }
}
return { json: { ...req, input } };
` });
  const handle = w.code('Handle', { modules: ['services/complaint.js'], main: `
const { _router, route, ...req } = $json;
const snap = $('Load Complaint Data').item.json.snap || {};
return { json: { out: complaintHandle(req, snap), wa_hash: req.wa_hash, lang: req.lang } };
` });
  const effects = w.pg('Apply Effects', 'select svc_complaint.apply_effects($1::jsonb) as r',
    '={{ [ JSON.stringify({ wa_hash: $json.wa_hash, effects: $json.out.effects || [] }) ] }}');
  const finish = w.code('Finish', { modules: ['services/complaint.js'], main: `
const h = $('Handle').item.json;
let out = h.out;
if ((out.effects || []).some((e) => e.type === 'create_complaint')) {
  out = complaintReceiptMessage({ lang: h.lang }, ($json.r && $json.r.complaint_id) || null);
}
return { json: out };
` });
  const ret = w.code('Return', { main: `
const { effects, ...out } = $json;
return { json: out };
` });
  w.chain(trig, load, media, handle, effects, finish, ret);
  return w;
}

// ---------------------------------------------------------------------------
// sync-mela: Google Sheet -> validate -> atomic replace (or keep old data + alert)
// Runs every 10 minutes; can also be called (tests, "sync now" from the runbook).
// ---------------------------------------------------------------------------
export function syncMela() {
  const w = new Workflow(IDS.syncMela, 'sync-mela');
  const cron = w.add('Every 10 Minutes', 'n8n-nodes-base.scheduleTrigger', 1.2,
    { rule: { interval: [{ field: 'minutes', minutesInterval: 10 }] } }, { y: -150 });
  w.x = 0;
  const called = w.trigger('When Called');
  const fetch = w.code('Fetch Sheet', { mode: 'runOnceForAllItems', main: `
// Service-account auth without an n8n credential: sign a JWT (RS256) and swap it
// for an access token, then read every tab in one batchGet call.
const crypto = require('crypto');
const TABS = ['places', 'control_room', 'events', 'guidelines', 'settings'];
try {
  const raw = String($env.GOOGLE_SA_JSON || '').trim();
  if (!raw) throw new Error('GOOGLE_SA_JSON is not set');
  const sa = JSON.parse(raw.startsWith('{') ? raw : Buffer.from(raw, 'base64').toString('utf8'));
  const tokenUrl = $env.GOOGLE_TOKEN_URL || sa.token_uri || 'https://oauth2.googleapis.com/token';
  const now = Math.floor(Date.now() / 1000);
  const b64u = (o) => Buffer.from(typeof o === 'string' ? o : JSON.stringify(o)).toString('base64url');
  const unsigned = b64u({ alg: 'RS256', typ: 'JWT' }) + '.' + b64u({ iss: sa.client_email,
    scope: 'https://www.googleapis.com/auth/spreadsheets.readonly', aud: tokenUrl, iat: now, exp: now + 3600 });
  const jwt = unsigned + '.' + crypto.createSign('RSA-SHA256').update(unsigned).sign(sa.private_key).toString('base64url');
  const tok = await this.helpers.httpRequest({ method: 'POST', url: tokenUrl, timeout: 15000, json: true,
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: 'grant_type=' + encodeURIComponent('urn:ietf:params:oauth:grant-type:jwt-bearer') + '&assertion=' + jwt });
  const base = $env.SHEETS_API_BASE || 'https://sheets.googleapis.com';
  const qs = TABS.map((t) => 'ranges=' + encodeURIComponent(t)).join('&') + '&valueRenderOption=FORMATTED_VALUE';
  const res = await this.helpers.httpRequest({ method: 'GET', timeout: 20000, json: true,
    url: base + '/v4/spreadsheets/' + encodeURIComponent($env.MELA_SHEET_ID) + '/values:batchGet?' + qs,
    headers: { Authorization: 'Bearer ' + tok.access_token } });
  const tabs = {};
  for (const vr of res.valueRanges || []) tabs[String(vr.range).split('!')[0].replace(/^'|'$/g, '')] = vr.values || [];
  return [{ json: { ok: true, tabs } }];
} catch (e) {
  return [{ json: { ok: false, fetch_error: String(e.message || e).slice(0, 300) } }];
}
` });
  const validate = w.code('Validate', { modules: ['services/mela_sheet.js'], main: `
if (!$json.ok) {
  return { json: { status: 'error', data: null, counts: {}, warnings: [], errors: [{ tab: '*', row: 0, msg: 'could not read the Google Sheet: ' + $json.fetch_error }] } };
}
// Fail safe: anything but an explicit test/staging environment (including a typo
// such as ENV=production, or ENV unset) publishes only verified rows.
const prod = !['test', 'staging'].includes(String($env.ENV || '').trim().toLowerCase());
const today = new Date(Date.now() + 5.5 * 3600e3).toISOString().slice(0, 10);
const r = validateMelaSheet($json.tabs, { requireVerified: prod, rejectPlaceholders: prod, today });
return { json: { status: r.errors.length ? 'rejected' : 'ok', data: r.data, counts: r.counts, errors: r.errors.slice(0, 50), warnings: r.warnings.slice(0, 50) } };
` });
  const apply = w.pg('Apply', `select
  case when ($1::jsonb)->>'status' = 'ok' then svc_mela.replace_all(($1::jsonb)->'data') end as applied,
  core.record_sync(jsonb_build_object('service_key', 'mela', 'source', 'google_sheets', 'status', ($1::jsonb)->>'status',
                   'rows', (($1::jsonb)->'counts'->>'places')::int, 'errors', ($1::jsonb)->'errors')) as rec`,
    '={{ [ JSON.stringify($json) ] }}');
  const summary = w.code('Summary', { main: `
const v = $('Validate').item.json;
const shouldAlert = !!($json.rec && $json.rec.should_alert);
const first = (v.errors || []).slice(0, 5).map((e) => e.tab + (e.row ? ' row ' + e.row : '') + ': ' + e.msg).join(' | ');
return { json: { status: v.status, applied: $json.applied, counts: v.counts, errors: v.errors, warnings: v.warnings,
  alert: shouldAlert ? 'Mela sheet NOT synced (bot keeps the previous data). Fix: ' + first : null } };
` });
  const needsAlert = w.switchOn('Needs Alert?', 2, '={{ $json.alert ? 1 : 0 }}');
  const alert = w.execute('Alert Admins', IDS.alert, { wait: false });
  // Both paths end in "Result", so callers always get the summary back.
  const result = w.code('Result', { main: `
return { json: $('Summary').item.json };
` });
  w.connect(cron, fetch);
  w.chain(called, fetch, validate, apply, summary, needsAlert);
  w.connect(needsAlert, result, 0);
  w.connect(needsAlert, alert, 1);
  w.connect(alert, result);
  return w;
}
