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
