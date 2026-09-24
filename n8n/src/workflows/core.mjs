// Core platform workflows. Service workflows live in services.mjs.
import { Workflow, IDS } from './lib.mjs';

const TURN_MODULES = ['core/route.js', 'core/menu.js', 'core/contract.js', 'core/turn.js'];

// ---------------------------------------------------------------------------
// core-00-router: Meta webhook (GET verify + POST messages) -> services -> send
// ---------------------------------------------------------------------------
export function router() {
  const w = new Workflow(IDS.router, 'core-00-router', { errorWorkflow: IDS.error });

  // GET: Meta's one-time verify handshake. The query keys are literally dotted.
  const get = w.add('WA Verify (GET)', 'n8n-nodes-base.webhook', 2.1,
    { httpMethod: 'GET', path: 'wa', responseMode: 'responseNode', options: {} },
    { webhookId: '4f1c2b8e-9a51-4d7e-8f3a-000000000001', y: -300 });
  const check = w.code('Check Verify Token', { mode: 'runOnceForAllItems', main: `
const q = $input.first().json.query || {};
const token = $env.WHATSAPP_VERIFY_TOKEN;
const ok = q['hub.mode'] === 'subscribe' && !!token && q['hub.verify_token'] === token;
return [{ json: { code: ok ? 200 : 403, body: ok ? String(q['hub.challenge'] || '') : 'forbidden' } }];
` }, { y: -300 });
  const respond = w.add('Respond Verify', 'n8n-nodes-base.respondToWebhook', 1.5,
    { respondWith: 'text', responseBody: '={{ $json.body }}', options: { responseCode: '={{ $json.code }}' } }, { y: -300 });
  w.chain(get, check, respond);

  // POST: every inbound message. Ack 200 immediately (Meta retries slow acks).
  w.x = 0;
  const post = w.add('WA Inbound (POST)', 'n8n-nodes-base.webhook', 2.1,
    { httpMethod: 'POST', path: 'wa', responseMode: 'onReceived', options: { rawBody: true } },
    { webhookId: '4f1c2b8e-9a51-4d7e-8f3a-000000000002' });
  const explode = w.code('Verify & Explode', {
    mode: 'runOnceForAllItems',
    modules: ['core/signature.js', 'core/explode.js', 'core/normalize.js'],
    main: `
const crypto = require('crypto');
const first = $input.first();
let raw = '';
if (first.binary && first.binary.data) raw = (await this.helpers.getBinaryDataBuffer(0, 'data')).toString('utf8');
const headers = first.json.headers || {};
if (!verifySignature(raw, headers['x-hub-signature-256'], $env.META_APP_SECRET, crypto)) {
  return []; // unsigned or forged request: drop silently, never reply
}
return explodeWebhook(first.json.body).map((m) => ({
  json: { wa_id: m.wa_id, msg_id: m.msg_id, input: normalizeMessage(m.message) },
}));
` });
  const begin = w.pg('Begin Turn', 'select core.rpc_begin_turn($1::jsonb) as turn',
    "={{ [ JSON.stringify({ wa_id: $json.wa_id, msg_id: $json.msg_id, kind: $json.input.kind, text: $json.input.text, lang_guess: $json.input.lang_guess, hash_secret: $env.PHONE_HASH_SECRET, enc_key: $env.PGCRYPTO_KEY }) ] }}");
  const decide = w.code('Decide', { modules: TURN_MODULES, main: `
const src = $('Verify & Explode').item.json;
const d = decideTurn(src, $json.turn, { llmEnv: String($env.LLM_ENABLED ?? 'true') !== 'false', nowMs: Date.now() });
return { json: { ...d, route: { stop: 0, reply: 1, service: 2, llm: 3 }[d.action] } };
` });
  const route = w.switchOn('Route', 4, '={{ $json.route }}');
  w.chain(post, explode, begin, decide, route);

  // LLM branch (free text with no pending state)
  const classify = w.execute('Classify (LLM)', IDS.llm, { wait: true }, { y: 300 });
  const afterLlm = w.code('After LLM', { modules: TURN_MODULES, main: `
const d = $('Decide').item.json;
const n = afterLlm(d, $json);
return { json: { ...n, route: n.action === 'service' ? 1 : 0 } };
` }, { y: 300 });
  const llmRoute = w.switchOn('LLM Route', 2, '={{ $json.route }}');
  w.connect(route, classify, 3);
  w.chain(classify, afterLlm, llmRoute);

  // Service call
  const prep = w.code('Prepare Service Call', { modules: TURN_MODULES, main: `
return { json: { ...serviceInput($json), _router: $json } };
` });
  const call = w.execute('Call Service', '={{ $json._router.service.workflow_id }}', { wait: true, onError: 'continueErrorOutput' });
  const after = w.code('After Service', { modules: TURN_MODULES, main: `
const d = $('Prepare Service Call').item.json._router;
return { json: finalizeTurn(d, afterService(d, $json)) };
` });
  const failed = w.code('Service Failed', { modules: TURN_MODULES, main: `
const d = $('Prepare Service Call').item.json._router;
const why = ($json.error && ($json.error.message || JSON.stringify($json.error))) || 'service error';
return { json: finalizeTurn(d, afterService(d, null, why)) };
` }, { y: 200 });
  w.connect(route, prep, 2);
  w.connect(llmRoute, prep, 1);
  w.connect(prep, call);
  w.connect(call, after, 0);
  w.connect(call, failed, 1);

  // Core replies (menu, language, feedback, rate-limit notice, LLM miss)
  const finReply = w.code('Finalize Reply', { modules: TURN_MODULES, main: `
return { json: finalizeTurn($json, null) };
` }, { y: -150 });
  w.connect(route, finReply, 1);
  w.connect(llmRoute, finReply, 0);

  // Fan-in: send, persist the turn, alert admins if a service misbehaved
  const send = w.execute('Send Reply', IDS.send, { wait: true, onError: 'continueRegularOutput' });
  const end = w.pg('End Turn', 'select core.rpc_end_turn($1::jsonb) as r', '={{ [ JSON.stringify($json.end) ] }}', { y: 150 });
  const needsAlert = w.switchOn('Needs Alert?', 2, '={{ $json.alert ? 1 : 0 }}');
  const alert = w.execute('Alert Admins', IDS.alert, { wait: false }, { y: 300 });
  for (const src of [after, failed, finReply]) {
    w.connect(src, send);
    w.connect(src, end);
    w.connect(src, needsAlert);
  }
  w.connect(needsAlert, alert, 1);
  return w;
}

// ---------------------------------------------------------------------------
// core-01-send: render contract messages -> phone guard -> Graph API -> log
// ---------------------------------------------------------------------------
export function send() {
  const w = new Workflow(IDS.send, 'core-01-send');
  const trig = w.trigger();
  const render = w.code('Render', { mode: 'runOnceForAllItems', modules: ['core/render.js', 'core/phone_guard.js'], main: `
const out = [];
for (const it of $input.all()) {
  const s = it.json.send || {};
  for (const m of s.messages || []) {
    for (const payload of renderMessage(m, s.to)) {
      const text = visibleText(payload);
      out.push({ json: { payload, wa_hash: s.wa_hash, service_key: s.service_key, lang: s.lang, kind: m.type, text, phones: extractPhones(text) } });
    }
  }
}
return out;
` });
  const check = w.pg('Phone Check',
    'select core.disallowed_numbers(array(select jsonb_array_elements_text($1::jsonb))) as bad',
    '={{ [ JSON.stringify($json.phones || []) ] }}');
  const guard = w.code('Guard', { main: `
const r = $('Render').item.json;
const bad = $json.bad || [];
if (!bad.length) return { json: { ...r, blocked: null } };
// A number that is not in the verified data must never reach a citizen.
const body = r.lang === 'hi' ? 'माफ़ कीजिए, यह जानकारी अभी उपलब्ध नहीं है।' : 'Sorry, this information is not available right now.';
return { json: { ...r, blocked: bad, text: body, payload: { messaging_product: 'whatsapp', recipient_type: 'individual', to: r.payload.to, type: 'text', text: { body } } } };
` });
  // Send strictly one after another, awaiting each response, so a citizen's
  // messages arrive in order (the HTTP Request node may overlap requests).
  const http = w.code('WhatsApp API', { mode: 'runOnceForAllItems', main: `
const url = ($env.WA_API_BASE || 'https://graph.facebook.com') + '/' + ($env.GRAPH_API_VERSION || 'v23.0') + '/' + $env.WHATSAPP_PHONE_NUMBER_ID + '/messages';
const out = [];
for (const [i, it] of $input.all().entries()) {
  let result = null;
  for (let attempt = 1; attempt <= 2 && !result; attempt++) {
    try {
      const res = await this.helpers.httpRequest({
        method: 'POST', url, json: true, body: it.json.payload, timeout: 10000,
        headers: { Authorization: 'Bearer ' + $env.WHATSAPP_ACCESS_TOKEN },
        returnFullResponse: true, ignoreHttpStatusErrors: true,
      });
      const retryable = res.statusCode === 429 || res.statusCode >= 500;
      if (res.statusCode < 300) result = { out_id: ((res.body.messages || [])[0] || {}).id || null, error: null };
      else if (!retryable || attempt === 2) result = { out_id: null, error: 'HTTP ' + res.statusCode + ': ' + JSON.stringify(res.body).slice(0, 400) };
    } catch (e) {
      if (attempt === 2) result = { out_id: null, error: String(e.message || e).slice(0, 400) };
    }
    if (!result) await new Promise((r) => setTimeout(r, 1000));
  }
  out.push({ json: result, pairedItem: { item: i } });
}
return out;
` });
  const log = w.pg('Log Outbound', 'select core.rpc_log_out($1::jsonb) as r', `={{ [ JSON.stringify({
  wa_hash: $('Guard').item.json.wa_hash,
  service_key: $('Guard').item.json.service_key,
  kind: $('Guard').item.json.kind,
  text: $('Guard').item.json.text,
  out_id: $json.out_id,
  error: $json.error || ($('Guard').item.json.blocked ? 'phone_guard:' + $('Guard').item.json.blocked.join(',') : null)
}) ] }}`);
  w.chain(trig, render, check, guard, http, log);
  return w;
}

// ---------------------------------------------------------------------------
// core-02-llm: free-text classifier (Claude Haiku 4.5, structured output)
// ---------------------------------------------------------------------------
export function llm() {
  const w = new Workflow(IDS.llm, 'core-02-llm');
  const trig = w.trigger();
  const build = w.code('Build Request', { modules: ['core/llm.js'], main: `
const env = $json.env || {};
return { json: { request: buildClassifierRequest(env.input.text, env.services || [], $env.LLM_MODEL), services: env.services || [] } };
` });
  const http = w.add('Claude API', 'n8n-nodes-base.httpRequest', 4.3, {
    method: 'POST',
    url: "={{ ($env.ANTHROPIC_BASE_URL || 'https://api.anthropic.com') + '/v1/messages' }}",
    sendHeaders: true,
    headerParameters: { parameters: [
      { name: 'x-api-key', value: '={{ $env.ANTHROPIC_API_KEY }}' },
      { name: 'anthropic-version', value: '2023-06-01' },
    ] },
    sendBody: true,
    contentType: 'json',
    specifyBody: 'json',
    jsonBody: '={{ JSON.stringify($json.request) }}',
    options: { timeout: 8000 },
  }, { onError: 'continueRegularOutput' });
  const parse = w.code('Parse', { modules: ['core/llm.js'], main: `
const b = $('Build Request').item.json;
return { json: parseClassifierResponse($json, b.services) };
` });
  w.chain(trig, build, http, parse);
  return w;
}

// ---------------------------------------------------------------------------
// core-03-admin-alert: WhatsApp template message to every admin number
// ---------------------------------------------------------------------------
export function alert() {
  const w = new Workflow(IDS.alert, 'core-03-admin-alert');
  const trig = w.trigger();
  const build = w.code('Build Alert', { mode: 'runOnceForAllItems', main: `
const admins = String($env.ADMIN_WA_NUMBERS || '').split(',').map((s) => s.trim()).filter(Boolean);
const out = [];
for (const it of $input.all()) {
  // template parameters may not contain newlines/tabs or long runs of spaces
  const text = String(it.json.alert || it.json.text || 'alert').replace(/\\s+/g, ' ').slice(0, 900);
  for (const to of admins) {
    out.push({ json: { send: { to, wa_hash: 'admin', lang: 'en', service_key: 'admin', messages: [{
      type: 'template',
      template: { name: $env.ADMIN_ALERT_TEMPLATE || 'admin_alert', language: { code: 'en' },
                  components: [{ type: 'body', parameters: [{ type: 'text', text }] }] },
    }] } } });
  }
}
return out;
` });
  const send = w.execute('Send', IDS.send, { wait: true });
  w.chain(trig, build, send);
  return w;
}

// ---------------------------------------------------------------------------
// core-08-error: any unhandled router failure -> admin alert
// ---------------------------------------------------------------------------
export function error() {
  const w = new Workflow(IDS.error, 'core-08-error');
  const trig = w.add('Error Trigger', 'n8n-nodes-base.errorTrigger', 1, {});
  const describe = w.code('Describe', { mode: 'runOnceForAllItems', main: `
const e = $input.first().json;
const wf = (e.workflow || {}).name || 'workflow';
const ex = e.execution || {};
return [{ json: { alert: 'n8n error in ' + wf + ' at node ' + (ex.lastNodeExecuted || '?') + ': ' + ((ex.error || {}).message || 'unknown') + ' (execution ' + (ex.id || '?') + ')' } }];
` });
  const send = w.execute('Alert Admins', IDS.alert, { wait: true });
  w.chain(trig, describe, send);
  return w;
}

// ---------------------------------------------------------------------------
// core-99-test-harness: call any service directly (published only when ENV=test)
// ---------------------------------------------------------------------------
export function harness() {
  const w = new Workflow(IDS.harness, 'core-99-test-harness');
  const hook = w.add('Harness Hook', 'n8n-nodes-base.webhook', 2.1,
    { httpMethod: 'POST', path: 'test/service', responseMode: 'lastNode', responseData: 'firstEntryJson', options: {} },
    { webhookId: '4f1c2b8e-9a51-4d7e-8f3a-000000000099' });
  const guard = w.code('Test Env Only', { mode: 'runOnceForAllItems', main: `
if ($env.ENV !== 'test') throw new Error('test harness is disabled outside ENV=test');
const b = $input.first().json.body || {};
return [{ json: { ...(b.input || {}), _target: b.workflow_id } }];
` });
  const run = w.execute('Run Service', '={{ $json._target }}', { wait: true });
  w.chain(hook, guard, run);
  return w;
}
