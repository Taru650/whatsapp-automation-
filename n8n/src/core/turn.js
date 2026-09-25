// Turn orchestration: pure functions the router's Code nodes call.
//
//   decideTurn()  -> { action: 'stop' | 'reply' | 'service' | 'llm', env, ... }
//   afterLlm()    -> same shape (service or reply)
//   afterService()-> { messages, next_state, context, done, log, alert }
//   finalizeTurn()-> { send, end, alert }
//
// `env` (the turn envelope) travels between nodes and carries everything the
// later steps need, so no step has to re-query the database.
// Depends on: decideRoute (route.js), buildMainMenu/tpl (menu.js),
// validateServiceOutput (contract.js). Inside n8n those are concatenated into
// the same Code node; under node:test they are required here.
const _turnDeps = (typeof require === 'function' && typeof decideRoute === 'undefined')
  ? { ...require('./route.js'), ...require('./menu.js'), ...require('./contract.js') }
  : null;
const _decideRoute = (a) => (_turnDeps ? _turnDeps.decideRoute(a) : decideRoute(a));
const _buildMainMenu = (a, b, c) => (_turnDeps ? _turnDeps.buildMainMenu(a, b, c) : buildMainMenu(a, b, c));
const _tpl = (a, b, c) => (_turnDeps ? _turnDeps.tpl(a, b, c) : tpl(a, b, c));
const _validate = (a, b) => (_turnDeps ? _turnDeps.validateServiceOutput(a, b) : validateServiceOutput(a, b));

function istNow(date) {
  const d = date || new Date();
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone: 'Asia/Kolkata', year: 'numeric', month: '2-digit', day: '2-digit',
    hour: '2-digit', minute: '2-digit', hour12: false,
  }).formatToParts(d);
  const get = (t) => (parts.find((p) => p.type === t) || {}).value;
  const hour = get('hour') === '24' ? '00' : get('hour');
  return `${get('year')}-${get('month')}-${get('day')} ${hour}:${get('minute')}`;
}

function splitContext(ctx) {
  const all = ctx && typeof ctx === 'object' ? ctx : {};
  const { __core, ...service } = all;
  return { service, core: __core && typeof __core === 'object' ? __core : {} };
}

function buildEnv(item, turn, flags) {
  const { service, core } = splitContext(turn.context);
  return {
    wa_id: item.wa_id,
    msg_id: item.msg_id,
    input: item.input,
    wa_hash: turn.wa_hash,
    version: turn.version,
    lang: turn.lang === 'en' ? 'en' : 'hi',
    state: turn.state || null,
    context: service,
    core_ctx: core,
    first_contact: !!turn.first_contact,
    is_admin: !!turn.is_admin,
    services: turn.services || [],
    templates: turn.templates || {},
    llm_enabled: !!(flags && flags.llmEnv) && String((turn.settings || {}).llm_enabled) !== 'false',
    received_ms: (flags && flags.nowMs) || Date.now(),
  };
}

function t(env, key) {
  return _tpl(env.templates, key, env.lang);
}

// Main menu, or straight into the only service (single-service rule).
function menuOrOpen(env, pre, extra) {
  const m = _buildMainMenu(env.services, env.lang, env.templates);
  if (m.kind === 'open_service') {
    return { action: 'service', env, service: m.service, pre,
             input: { kind: 'open', id: `${m.service.id_prefix}:open`, text: null, lat: null, lon: null }, ...extra };
  }
  return { action: 'reply', env, pre, messages: m.messages, state: null, context: {}, service_key: null, done: false, ...extra };
}

function decideTurn(item, turn, flags) {
  if (!turn || turn.is_dup) return { action: 'stop', reason: 'duplicate' };
  const env = buildEnv(item, turn, flags);
  if (turn.rate_limited) {
    if (!turn.rate_notice) return { action: 'stop', reason: 'rate_limited' };
    return { action: 'reply', env, pre: [], messages: [{ type: 'text', body: t(env, 'rate_limited') }],
             state: env.state, context: env.context, service_key: null, done: false, skip_end: true };
  }
  const route = _decideRoute({ input: env.input, state: env.state, services: env.services, isAdmin: env.is_admin, llmEnabled: env.llm_enabled });
  const via = env.input.kind === 'text' ? 'text' : env.input.kind;
  switch (route.action) {
    case 'unsupported':
      return menuOrOpen(env, [{ type: 'text', body: t(env, 'unsupported') }], { subtype: 'unsupported' });
    case 'lang':
      env.lang = route.lang;
      return menuOrOpen(env, [{ type: 'text', body: t(env, 'lang_switched') }], { set_lang: route.lang });
    case 'feedback':
      return { action: 'reply', env, pre: [], messages: [{ type: 'text', body: t(env, 'feedback_thanks') }],
               state: env.state, context: env.context, service_key: route.service_key, done: false,
               feedback_rating: route.rating, subtype: 'feedback' };
    case 'not_allowed':
      return menuOrOpen(env, [{ type: 'text', body: t(env, 'not_allowed') }]);
    case 'service':
      return { action: 'service', env, service: route.service, pre: [], input: env.input, via: route.via || via };
    case 'llm':
      return { action: 'llm', env };
    case 'menu':
    default:
      return menuOrOpen(env, [], route.reason === 'no_llm' ? { unanswered_reason: 'llm_disabled' } : {});
  }
}

function afterLlm(decision, result) {
  const env = decision.env;
  const r = result || {};
  if (r.ok) {
    const service = env.services.find((s) => s.service_key === r.service_key);
    if (service) {
      return { action: 'service', env, service, pre: [], via: 'llm', llm_tokens: r.tokens || 0,
               input: { ...env.input, intent: { subtype: r.subtype, slots: r.slots || {} } } };
    }
  }
  return menuOrOpen(env, [{ type: 'text', body: t(env, 'not_understood') }],
                    { unanswered_reason: r.reason || 'no_service', llm_tokens: r.tokens || 0 });
}

function serviceInput(decision) {
  const env = decision.env;
  return {
    wa_hash: env.wa_hash,
    lang: env.lang,
    // A different service's pending state is not this service's business.
    state: env.state && env.state.startsWith(`${decision.service.id_prefix}.`) ? env.state : null,
    context: env.state && env.state.startsWith(`${decision.service.id_prefix}.`) ? env.context : {},
    now_iso: new Date(env.received_ms).toISOString(),
    now_ist: istNow(new Date(env.received_ms)),
    is_admin: env.is_admin,
    input: decision.input,
  };
}

function afterService(decision, out, errorMessage) {
  const env = decision.env;
  const key = decision.service.service_key;
  const fail = (why) => ({
    messages: [{ type: 'text', body: t(env, 'error_apology') }],
    next_state: env.state, context: env.context, done: false,
    log: { subtype: 'error', resolved: false },
    alert: `Service "${key}" failed for input ${JSON.stringify(decision.input && (decision.input.id || decision.input.kind))}: ${why}`,
  });
  if (errorMessage) return fail(errorMessage);
  const errors = _validate(out, decision.service.id_prefix);
  if (errors.length) return fail(`contract violation: ${errors.join('; ')}`);
  return {
    messages: out.messages,
    next_state: out.next_state == null ? null : out.next_state,
    context: out.context || {},
    done: !!out.done,
    log: out.log || {},
    alert: null,
  };
}

function feedbackPrompt(env, serviceKey) {
  return {
    type: 'buttons',
    body: t(env, 'feedback_prompt'),
    buttons: [
      { id: `fb:up:${serviceKey}`, title: t(env, 'btn_helpful') },
      { id: `fb:down:${serviceKey}`, title: t(env, 'btn_not_helpful') },
      { id: 'core:menu', title: t(env, 'btn_menu') },
    ],
  };
}

// decision: output of decideTurn/afterLlm; result: afterService() output or null for core replies.
function finalizeTurn(decision, result) {
  const env = decision.env;
  const serviceKey = decision.service ? decision.service.service_key : decision.service_key || null;
  const r = result || { messages: decision.messages || [], next_state: decision.state, context: decision.context || {}, done: !!decision.done, log: {} };
  const coreCtx = { ...env.core_ctx };
  const messages = [];
  if (env.first_contact) messages.push({ type: 'text', body: t(env, 'welcome_notice') });
  messages.push(...(decision.pre || []), ...(r.messages || []));
  if (r.done && serviceKey && !coreCtx.fb_asked) {
    messages.push(feedbackPrompt(env, serviceKey));
    coreCtx.fb_asked = true;
  }
  const log = r.log || {};
  return {
    send: { to: env.wa_id, wa_hash: env.wa_hash, lang: env.lang, service_key: serviceKey, messages },
    end: decision.skip_end ? null : {
      wa_hash: env.wa_hash,
      version: env.version,
      state: r.next_state || null,
      context: { ...(r.context || {}), __core: coreCtx },
      in_msg_id: env.msg_id,
      service_key: serviceKey,
      subtype: log.subtype || decision.subtype || null,
      via: decision.via || (env.input.kind === 'text' ? 'text' : env.input.kind),
      resolved: log.resolved != null ? !!log.resolved : !(decision.unanswered_reason || log.unanswered_reason),
      detail: log.detail || null,
      // classifier tokens (router) + any tokens the service spent itself (e.g. Q&A)
      llm_tokens: ((decision.llm_tokens || 0) + (log.llm_tokens || 0)) || null,
      latency_ms: Math.max(0, Date.now() - env.received_ms),
      set_lang: decision.set_lang || null,
      feedback_rating: decision.feedback_rating == null ? null : decision.feedback_rating,
      unanswered_reason: decision.unanswered_reason || log.unanswered_reason || null,
      text: env.input.kind === 'text' ? env.input.text : null,
    },
    alert: r.alert || null,
  };
}

if (typeof module !== 'undefined') {
  module.exports = { decideTurn, afterLlm, serviceInput, afterService, finalizeTurn, istNow, splitContext };
}
