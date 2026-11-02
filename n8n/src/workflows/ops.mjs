// Scheduled operations workflows (M3): the 08:00 daily report and the nightly
// retention purge. Both can also be called (test harness, runbook "run now").
import { Workflow, IDS, SMTP_CREDENTIAL } from './lib.mjs';

// ---------------------------------------------------------------------------
// core-85-daily-report: yesterday's figures to the admins at 08:00 IST, as the
// admin_alert WhatsApp template (one line) and, if SMTP is configured, by e-mail
// (full text). Input when called: { day?: 'YYYY-MM-DD' }.
// ---------------------------------------------------------------------------
export function dailyReport() {
  const w = new Workflow(IDS.report, 'core-85-daily-report', { errorWorkflow: IDS.error });
  const cron = w.add('Daily 08:00 IST', 'n8n-nodes-base.scheduleTrigger', 1.2,
    { rule: { interval: [{ field: 'cronExpression', expression: '0 8 * * *' }] } }, { y: -150 });
  w.x = 0;
  const called = w.trigger('When Called');
  const build = w.pg('Build Report', 'select analytics.daily_report(nullif($1, \'\')::date) as r',
    "={{ [ /^\\d{4}-\\d{2}-\\d{2}$/.test(String($json.day || '')) ? $json.day : '' ] }}");
  const shape = w.code('Shape', { main: `
const r = $json.r;
return { json: { report: r, alert: r.line,
  subject: 'Citizen bot daily report ' + r.day, text: r.text,
  email: !!($env.SMTP_HOST && $env.REPORT_EMAIL_TO) } };
` });
  // one item out per admin message (or none without admins): collapse to one
  const wa = w.execute('WhatsApp Admins', IDS.alert, { wait: true, onError: 'continueRegularOutput' }, { alwaysOutputData: true });
  const once = w.code('Once', { mode: 'runOnceForAllItems', main: `
return [{ json: { whatsapp_items: $input.all().filter((i) => i.json && Object.keys(i.json).length).length } }];
` });
  const wantsEmail = w.switchOn('E-mail?', 2, "={{ $('Shape').first().json.email ? 1 : 0 }}");
  const mail = w.add('E-mail Report', 'n8n-nodes-base.emailSend', 2.1, {
    resource: 'email', operation: 'send',
    fromEmail: "={{ $env.REPORT_EMAIL_FROM || 'citizen-bot@localhost' }}",
    toEmail: '={{ $env.REPORT_EMAIL_TO }}',
    subject: "={{ $('Shape').first().json.subject }}",
    emailFormat: 'text',
    text: "={{ $('Shape').first().json.text }}",
    options: { appendAttribution: false },
  }, { credentials: SMTP_CREDENTIAL, onError: 'continueRegularOutput' });
  const result = w.code('Result', { mode: 'runOnceForAllItems', main: `
const s = $('Shape').first().json;
// on the e-mail branch the input is the e-mail node's output (an error item if SMTP failed)
const emailed = s.email ? !($input.first().json || {}).error : false;
return [{ json: { day: s.report.day, text: s.text, line: s.alert, whatsapp_items: $('Once').first().json.whatsapp_items, emailed } }];
` });
  w.connect(cron, build);
  w.chain(called, build, shape, wa, once, wantsEmail);
  w.connect(wantsEmail, result, 0);
  w.connect(wantsEmail, mail, 1);
  w.connect(mail, result);
  return w;
}

// ---------------------------------------------------------------------------
// core-09-purge: nightly 03:15 IST. Archives day aggregates, then deletes
// personal data older than settings.retention_days (180). Alerts on failure.
// ---------------------------------------------------------------------------
export function purge() {
  const w = new Workflow(IDS.purge, 'core-09-purge', { errorWorkflow: IDS.error });
  const cron = w.add('Nightly 03:15 IST', 'n8n-nodes-base.scheduleTrigger', 1.2,
    { rule: { interval: [{ field: 'cronExpression', expression: '15 3 * * *' }] } }, { y: -150 });
  w.x = 0;
  const called = w.trigger('When Called');
  const run = w.pg('Run Purge', 'select core.run_purge() as r, $1::int as i', '={{ [ 0 ] }}',
    { onError: 'continueRegularOutput' });
  const summary = w.code('Summary', { main: `
const failed = !$json.r;
return { json: { ok: !failed, purged: $json.r || null,
  alert: failed ? 'Nightly data purge FAILED: ' + String(($json.error && ($json.error.message || $json.error)) || 'unknown error').slice(0, 300) : null } };
` });
  const needsAlert = w.switchOn('Needs Alert?', 2, '={{ $json.alert ? 1 : 0 }}');
  const alert = w.execute('Alert Admins', IDS.alert, { wait: true, onError: 'continueRegularOutput' });
  const result = w.code('Result', { main: `
return { json: $('Summary').item.json };
` });
  w.connect(cron, run);
  w.chain(called, run, summary, needsAlert);
  w.connect(needsAlert, result, 0);
  w.connect(needsAlert, alert, 1);
  w.connect(alert, result);
  return w;
}

// ---------------------------------------------------------------------------
// core-11-notify-poll: every minute, sends citizens their complaint status
// updates (grievance.notification_outbox, written by a trigger whenever the
// portal changes a status). Same render -> phone guard -> Graph API -> log
// modules as core-01-send, inline here (as in core-00-router) because the
// poll needs each message's outcome to mark the row sent or retry it.
// Deliberately no errorWorkflow: a persistent fault (DB down) would alert the
// admins every minute; core-04-health already covers the DB, and rows that
// fail for good are alerted once, below.
// ---------------------------------------------------------------------------
const NOTIFY_MODULES = ['core/render.js', 'core/phone_guard.js', 'core/deliver.js', 'services/complaint_notify.js'];

export function notifyPoll() {
  const w = new Workflow(IDS.notify, 'core-11-notify-poll');
  const cron = w.add('Every Minute', 'n8n-nodes-base.scheduleTrigger', 1.2,
    { rule: { interval: [{ field: 'cronExpression', expression: '* * * * *' }] } }, { y: -150 });
  w.x = 0;
  const called = w.trigger('When Called');
  const claim = w.pg('Claim Due',
    'select svc_complaint.claim_notifications(50, $1) as batch, core.allowed_numbers() as allowed',
    '={{ [ $env.PGCRYPTO_KEY ] }}');
  const sendAll = w.code('Send Updates', { mode: 'runOnceForAllItems', modules: NOTIFY_MODULES, main: `
const { batch, allowed } = $input.first().json;
const rows = batch || [];
const cfg = { base: $env.WA_API_BASE, version: $env.GRAPH_API_VERSION, phoneId: $env.WHATSAPP_PHONE_NUMBER_ID, token: $env.WHATSAPP_ACCESS_TOKEN };
const http = this.helpers.httpRequest.bind(this.helpers);
const template = $env.COMPLAINT_UPDATE_TEMPLATE || 'complaint_update';
const outs = [];
const results = [];
// one citizen after another, like every other send in this bot
for (const row of rows) {
  if (!row.to) {
    results.push({ id: row.id, ok: false, final: true, error: 'no WhatsApp number on record for this citizen (purged?)' });
    continue;
  }
  let messages;
  try {
    messages = buildStatusNotification(row.payload, row.lang, { template });
  } catch (e) {
    results.push({ id: row.id, ok: false, final: true, error: String(e.message || e) });
    continue;
  }
  const logs = await deliverMessages({ to: row.to, wa_hash: row.wa_hash, lang: row.lang, service_key: 'complaint', messages }, allowed, cfg, http);
  for (const l of logs) outs.push({ ...l, text: l.text || ('[' + template + '] ' + row.complaint_id + ' ' + row.payload.status) });
  const err = logs.map((l) => l.error).find(Boolean);
  results.push({ id: row.id, ok: logs.length > 0 && !err, error: err || (logs.length ? null : 'nothing sent'), out_id: (logs[0] || {}).out_id || null });
}
return [{ json: { claimed: rows.length, finish: { end: null, outs }, results } }];
` });
  const any = w.switchOn('Anything Claimed?', 2, '={{ $json.claimed > 0 ? 1 : 0 }}');
  const idle = w.code('Idle', { main: `
return { json: { claimed: 0, sent: 0, retrying: 0, failed: [] } };
` }, { y: 150 });
  const log = w.pg('Log Outbound', 'select core.rpc_finish_turn($1::jsonb) as r', '={{ [ JSON.stringify($json.finish) ] }}');
  const mark = w.pg('Mark Results', 'select svc_complaint.finish_notifications($1::jsonb) as r',
    "={{ [ JSON.stringify($('Send Updates').first().json.results) ] }}");
  const summary = w.code('Summary', { main: `
const r = $json.r;
const failed = r.failed || [];
return { json: { claimed: $('Send Updates').first().json.claimed, sent: r.sent, retrying: r.retrying, failed,
  alert: failed.length ? 'Complaint update NOT delivered to ' + failed.length + ' citizen(s) after retries: '
    + failed.slice(0, 5).map((f) => f.complaint_id + ' (' + String(f.error).replace(/\\s+/g, ' ').slice(0, 80) + ')').join('; ') : null } };
` });
  const needsAlert = w.switchOn('Needs Alert?', 2, '={{ $json.alert ? 1 : 0 }}');
  const alert = w.execute('Alert Admins', IDS.alert, { wait: true, onError: 'continueRegularOutput' });
  const result = w.code('Result', { mode: 'runOnceForAllItems', main: `
return [{ json: $('Summary').first().json }];
` });
  w.connect(cron, claim);
  w.chain(called, claim, sendAll, any);
  w.connect(any, idle, 0);
  w.connect(any, log, 1);
  w.chain(log, mark, summary, needsAlert);
  w.connect(needsAlert, result, 0);
  w.connect(needsAlert, alert, 1);
  w.connect(alert, result);
  return w;
}
