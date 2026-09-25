// Core platform workflows. Service workflows live in services.mjs.
import { Workflow, IDS } from './lib.mjs';

const TURN_MODULES = ['core/route.js', 'core/menu.js', 'core/contract.js', 'core/turn.js'];
const DELIVER_MODULES = ['core/render.js', 'core/phone_guard.js', 'core/deliver.js'];

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
// The raw body arrives inline as base64 (in-memory binary data). Read it directly:
// the getBinaryDataBuffer() helper round-trips through the task broker and was
// seen to hang for good after an overload, silently dropping every later message.
const bin = first.binary && first.binary.data;
let raw = '';
if (bin && bin.data && !bin.id) raw = Buffer.from(bin.data, 'base64').toString('utf8');
else if (bin) raw = (await this.helpers.getBinaryDataBuffer(0, 'data')).toString('utf8');
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
const route = { stop: 0, reply: 1, service: 2, llm: 3 }[d.action];
// service calls carry the service's input at the top level plus the turn in _router
return { json: d.action === 'service' ? { ...serviceInput(d), _router: d, route } : { ...d, route } };
` });
  const route = w.switchOn('Route', 4, '={{ $json.route }}');
  w.chain(post, explode, begin, decide, route);

  // LLM branch (free text with no pending state)
  const classify = w.execute('Classify (LLM)', IDS.llm, { wait: true }, { y: 300 });
  const afterLlm = w.code('After LLM', { modules: TURN_MODULES, main: `
const d = $('Decide').item.json;
const n = afterLlm(d, $json);
return { json: n.action === 'service' ? { ...serviceInput(n), _router: n, route: 1 } : { ...n, route: 0 } };
` }, { y: 300 });
  const llmRoute = w.switchOn('LLM Route', 2, '={{ $json.route }}');
  w.connect(route, classify, 3);
  w.chain(classify, afterLlm, llmRoute);

  // Service call (fan-in from Route and LLM Route)
  const prep = w.add('To Service', 'n8n-nodes-base.noOp', 1, {});
  const call = w.execute('Call Service', '={{ $json._router.service.workflow_id }}', { wait: true, onError: 'continueErrorOutput' });
  const after = w.code('After Service', { modules: TURN_MODULES, main: `
const d = $('To Service').item.json._router;
return { json: finalizeTurn(d, afterService(d, $json)) };
` });
  const failed = w.code('Service Failed', { modules: TURN_MODULES, main: `
const d = $('To Service').item.json._router;
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

  // Fan-in: deliver (render + phone guard + send, in order), then persist the turn
  // and every outbound log row in one DB call; alert admins if a service misbehaved.
  const done = w.add('Turn Done', 'n8n-nodes-base.noOp', 1, {});
  const allowed = w.pg('Allowed Numbers', 'select core.allowed_numbers() as allowed, $1::int as i', '={{ [ $itemIndex ] }}');
  const deliver = w.code('Deliver', { modules: DELIVER_MODULES, main: `
const t = $('Turn Done').item.json;
const logs = await deliverMessages(t.send, $json.allowed, {
  base: $env.WA_API_BASE, version: $env.GRAPH_API_VERSION, phoneId: $env.WHATSAPP_PHONE_NUMBER_ID, token: $env.WHATSAPP_ACCESS_TOKEN,
}, this.helpers.httpRequest.bind(this.helpers));
return { json: { finish: { end: t.end, outs: logs }, alert: t.alert } };
` });
  const needsAlert = w.switchOn('Needs Alert?', 2, '={{ $json.alert ? 1 : 0 }}');
  const finish = w.pg('Finish Turn', 'select core.rpc_finish_turn($1::jsonb) as r', '={{ [ JSON.stringify($json.finish) ] }}');
  const alert = w.execute('Alert Admins', IDS.alert, { wait: false }, { y: 300 });
  for (const src of [after, failed, finReply]) w.connect(src, done);
  w.chain(done, allowed, deliver, needsAlert);
  w.connect(needsAlert, finish, 0);
  w.connect(needsAlert, finish, 1);   // every turn is persisted...
  w.connect(needsAlert, alert, 1);    // ...and alerts get the Deliver item (with its alert text)
  return w;
}

// ---------------------------------------------------------------------------
// core-01-send: render contract messages -> phone guard -> Graph API -> log
// ---------------------------------------------------------------------------
export function send() {
  const w = new Workflow(IDS.send, 'core-01-send');
  const trig = w.trigger();
  const allowed = w.pg('Allowed Numbers', 'select core.allowed_numbers() as allowed, $1::int as i', '={{ [ $itemIndex ] }}');
  const deliver = w.code('Deliver', { modules: DELIVER_MODULES, main: `
const s = $('When Called').item.json.send;
const logs = await deliverMessages(s, $json.allowed, {
  base: $env.WA_API_BASE, version: $env.GRAPH_API_VERSION, phoneId: $env.WHATSAPP_PHONE_NUMBER_ID, token: $env.WHATSAPP_ACCESS_TOKEN,
}, this.helpers.httpRequest.bind(this.helpers));
return { json: { finish: { end: null, outs: logs } } };
` });
  const log = w.pg('Log Outbound', 'select core.rpc_finish_turn($1::jsonb) as r', '={{ [ JSON.stringify($json.finish) ] }}');
  w.chain(trig, allowed, deliver, log);
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
// core-04-health: GET /webhook/health for UptimeRobot. HTTP 500 if the DB is
// unreachable (bot down); 200 with status ok|degraded otherwise.
// ---------------------------------------------------------------------------
export function health() {
  const w = new Workflow(IDS.health, 'core-04-health');
  const hook = w.add('Health Hook', 'n8n-nodes-base.webhook', 2.1,
    { httpMethod: 'GET', path: 'health', responseMode: 'lastNode', responseData: 'firstEntryJson', options: {} },
    { webhookId: '4f1c2b8e-9a51-4d7e-8f3a-000000000004' });
  const check = w.pg('Check DB', 'select core.health() as h, $1::int as i', '={{ [ 0 ] }}');
  const shape = w.code('Shape', { main: `
return { json: $json.h };
` });
  w.chain(hook, check, shape);
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
