// Unit tests for the turn orchestration (n8n/src/core/turn.js).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { decideTurn, afterLlm, serviceInput, afterService, finalizeTurn, istNow, splitContext } = require('../../n8n/src/core/turn.js');

const TEMPLATES = Object.fromEntries(
  ['welcome_notice', 'menu_prompt', 'menu_button', 'menu_section', 'unsupported', 'rate_limited', 'error_apology',
   'not_understood', 'feedback_prompt', 'feedback_thanks', 'lang_switched', 'not_allowed', 'btn_helpful',
   'btn_not_helpful', 'btn_menu', 'btn_lang_other'].map((k) => [k, { hi: `${k}_hi`, en: `${k}_en` }]));
const echo = { service_key: 'echo', id_prefix: 'echo', title_en: 'Echo', title_hi: 'इको', menu_order: 1, workflow_id: 'W1', accepts_location: false };
const other = { ...echo, service_key: 'dir', id_prefix: 'dir', title_en: 'Dir', menu_order: 2, workflow_id: 'W2' };
const item = (input) => ({ wa_id: '919000000001', msg_id: 'wamid.X', input: { id: null, text: null, lat: null, lon: null, ...input } });
const turn = (over = {}) => ({ is_dup: false, wa_hash: 'h', version: 3, lang: 'en', state: null, context: {}, first_contact: false,
  is_admin: false, rate_limited: false, rate_notice: false, services: [echo], templates: TEMPLATES, settings: { llm_enabled: 'true' }, ...over });
const flags = { llmEnv: true, nowMs: Date.UTC(2026, 10, 24, 18, 45) }; // 25 Nov 00:15 IST

test('decide: duplicate and rate limit', () => {
  assert.equal(decideTurn(item({ kind: 'text', text: 'hi' }), { is_dup: true }, flags).action, 'stop');
  assert.equal(decideTurn(item({ kind: 'text', text: 'hi' }), turn({ rate_limited: true }), flags).action, 'stop');
  const d = decideTurn(item({ kind: 'text', text: 'hi' }), turn({ rate_limited: true, rate_notice: true }), flags);
  assert.equal(d.action, 'reply'); assert.equal(d.messages[0].body, 'rate_limited_en'); assert.equal(d.skip_end, true);
});

test('decide: single-service rule opens the service; two services show the menu', () => {
  const one = decideTurn(item({ kind: 'text', text: 'hi' }), turn(), flags);
  assert.equal(one.action, 'service'); assert.equal(one.input.kind, 'open'); assert.equal(one.input.id, 'echo:open');
  const two = decideTurn(item({ kind: 'text', text: 'hi' }), turn({ services: [echo, other] }), flags);
  assert.equal(two.action, 'reply'); assert.equal(two.messages[0].type, 'buttons');
});

test('decide: unsupported, language, feedback, llm, llm off', () => {
  const u = decideTurn(item({ kind: 'unsupported' }), turn(), flags);
  assert.equal(u.action, 'service'); assert.equal(u.pre[0].body, 'unsupported_en');
  const l = decideTurn(item({ kind: 'button', id: 'lang:hi' }), turn(), flags);
  assert.equal(l.set_lang, 'hi'); assert.equal(l.env.lang, 'hi'); assert.equal(l.pre[0].body, 'lang_switched_hi');
  const f = decideTurn(item({ kind: 'button', id: 'fb:up:echo' }), turn(), flags);
  assert.equal(f.feedback_rating, 1); assert.equal(f.service_key, 'echo');
  assert.equal(decideTurn(item({ kind: 'text', text: 'where is police' }), turn(), flags).action, 'llm');
  const off = decideTurn(item({ kind: 'text', text: 'where is police' }), turn({ settings: { llm_enabled: 'false' } }), flags);
  assert.equal(off.action, 'service'); assert.equal(off.unanswered_reason, 'llm_disabled');
  assert.equal(decideTurn(item({ kind: 'text', text: 'x' }), turn(), { llmEnv: false }).unanswered_reason, 'llm_disabled');
});

test('afterLlm: routes on success, falls back on failure', () => {
  const d = decideTurn(item({ kind: 'text', text: 'please echo' }), turn(), flags);
  const ok = afterLlm(d, { ok: true, service_key: 'echo', subtype: 'repeat', slots: { place: 'x' }, tokens: 50 });
  assert.equal(ok.action, 'service'); assert.equal(ok.via, 'llm'); assert.deepEqual(ok.input.intent, { subtype: 'repeat', slots: { place: 'x' } });
  const bad = afterLlm(d, { ok: false, reason: 'low_confidence', tokens: 40 });
  assert.equal(bad.unanswered_reason, 'low_confidence'); assert.equal(bad.pre[0].body, 'not_understood_en'); assert.equal(bad.llm_tokens, 40);
});

test('serviceInput: foreign state hidden, IST time', () => {
  const d = decideTurn(item({ kind: 'button', id: 'echo:again' }), turn({ state: 'dir.search', context: { q: 1 } , services: [echo, other]}), flags);
  const si = serviceInput(d);
  assert.equal(si.state, null); assert.deepEqual(si.context, {});
  assert.equal(si.now_ist, '2026-11-25 00:15');
  const own = serviceInput(decideTurn(item({ kind: 'text', text: 'abc' }), turn({ state: 'echo.wait', context: { last: 'a', __core: { fb_asked: true } } }), flags));
  assert.equal(own.state, 'echo.wait'); assert.deepEqual(own.context, { last: 'a' });
});

test('afterService: contract enforced, errors become apology + alert', () => {
  const d = decideTurn(item({ kind: 'button', id: 'echo:again' }), turn(), flags);
  const good = afterService(d, { messages: [{ type: 'text', body: 'ok' }], next_state: 'echo.wait', context: { a: 1 }, done: true, log: { subtype: 'repeat', resolved: true } });
  assert.equal(good.alert, null); assert.equal(good.done, true);
  const bad = afterService(d, { messages: [{ type: 'buttons', body: 'b', buttons: [{ id: 'dir:x', title: 't' }] }] });
  assert.equal(bad.messages[0].body, 'error_apology_en'); assert.match(bad.alert, /contract violation/);
  assert.match(afterService(d, null, 'workflow not found').alert, /workflow not found/);
});

test('finalize: welcome on first contact, feedback once per session, end params', () => {
  const d = decideTurn(item({ kind: 'button', id: 'echo:again' }), turn({ first_contact: true }), flags);
  const res = afterService(d, { messages: [{ type: 'text', body: 'ok' }], next_state: 'echo.wait', context: { a: 1 }, done: true, log: { subtype: 'repeat', resolved: true } });
  const f = finalizeTurn(d, res);
  assert.deepEqual(f.send.messages.map((m) => m.body), ['welcome_notice_en', 'ok', 'feedback_prompt_en']);
  assert.deepEqual(f.send.messages[2].buttons.map((b) => b.id), ['fb:up:echo', 'fb:down:echo', 'core:menu']);
  assert.deepEqual(f.end.context, { a: 1, __core: { fb_asked: true } });
  assert.equal(f.end.state, 'echo.wait'); assert.equal(f.end.version, 3); assert.equal(f.end.subtype, 'repeat');
  const d2 = decideTurn(item({ kind: 'button', id: 'echo:again' }), turn({ state: 'echo.wait', context: { a: 1, __core: { fb_asked: true } } }), flags);
  const f2 = finalizeTurn(d2, afterService(d2, { messages: [{ type: 'text', body: 'again' }], next_state: 'echo.wait', context: {}, done: true }));
  assert.deepEqual(f2.send.messages.map((m) => m.body), ['again']);
  const rl = finalizeTurn(decideTurn(item({ kind: 'text', text: 'x' }), turn({ rate_limited: true, rate_notice: true }), flags), null);
  assert.equal(rl.end, null);
});

test('feedback: at most once a day, even across conversations', () => {
  const answer = (over) => {
    const d = decideTurn(item({ kind: 'button', id: 'echo:again' }), turn(over), flags);
    return finalizeTurn(d, afterService(d, { messages: [{ type: 'text', body: 'ok' }], next_state: null, context: {}, done: true }));
  };
  const first = answer({});
  assert.equal(first.send.messages.at(-1).body, 'feedback_prompt_en');
  assert.equal(first.end.feedback_asked, true, 'recorded so it is not asked again today');
  // a new conversation (empty context) the same day: no second prompt
  const later = answer({ feedback_asked_today: true });
  assert.deepEqual(later.send.messages.map((m) => m.body), ['ok']);
  assert.equal(later.end.feedback_asked, false);
});

test('home service: "hi" opens its menu, which lists the other services; their rows open them', () => {
  const mela = { ...echo, service_key: 'mela', id_prefix: 'mela', title_en: 'Sonpur Mela', menu_order: 1 };
  const cmp = { ...echo, service_key: 'complaint', id_prefix: 'cmp', title_en: 'File a Complaint', title_hi: 'शिकायत दर्ज करें',
                description_en: 'Report a problem', menu_order: 0 };
  const home = turn({ services: [mela, cmp], settings: { home_service: 'mela' } });
  const hi = decideTurn(item({ kind: 'text', text: 'hi' }), home, flags);
  assert.equal(hi.action, 'service'); assert.equal(hi.service.service_key, 'mela'); assert.equal(hi.input.id, 'mela:open');
  const si = serviceInput(hi);
  assert.deepEqual(si.other_services.map((s) => [s.id, s.title_en, s.title_hi]), [['core:open:cmp', 'File a Complaint', 'शिकायत दर्ज करें']]);
  // the complaint service itself is not told about the others
  const open = decideTurn(item({ kind: 'list', id: 'core:open:cmp' }), home, flags);
  assert.equal(open.action, 'service'); assert.equal(open.service.service_key, 'complaint');
  assert.equal(open.input.id, 'cmp:open', 'the service sees its own open id');
  assert.deepEqual(serviceInput(open).other_services, []);
  // 🏠 Menu also goes home; with the setting off the 2-button menu comes back
  assert.equal(decideTurn(item({ kind: 'button', id: 'core:menu' }), home, flags).service.service_key, 'mela');
  const off = decideTurn(item({ kind: 'text', text: 'hi' }), turn({ services: [mela, cmp], settings: {} }), flags);
  assert.equal(off.action, 'reply'); assert.equal(off.messages[0].type, 'buttons');
  // a home service that is disabled (not in the list) is ignored
  assert.equal(decideTurn(item({ kind: 'text', text: 'hi' }), turn({ services: [echo, other], settings: { home_service: 'mela' } }), flags).action, 'reply');
  // a stale row for a disabled service just shows the menu
  assert.equal(decideTurn(item({ kind: 'list', id: 'core:open:gone' }), home, flags).service.service_key, 'mela');
});

test('unreadable messages (voice, video, sticker): a step in progress is kept, reactions get no reply', () => {
  const T2 = { ...TEMPLATES, unsupported_flow: { en: 'flow_en' } };
  for (const raw of ['audio', 'video', 'sticker']) {
    const mid = decideTurn(item({ kind: 'unsupported', raw_type: raw }),
      turn({ templates: T2, state: 'echo.wait', context: { draft: 1, __core: { fb_asked: true } } }), flags);
    assert.equal(mid.action, 'reply'); assert.equal(mid.messages[0].body, 'flow_en');
    const f = finalizeTurn(mid, null);
    assert.equal(f.end.state, 'echo.wait', `${raw}: the complaint step is not dropped`);
    assert.deepEqual(f.end.context, { draft: 1, __core: { fb_asked: true } });
  }
  const idle = decideTurn(item({ kind: 'unsupported', raw_type: 'audio' }), turn({ templates: T2 }), flags);
  assert.equal(idle.action, 'service'); assert.equal(idle.pre[0].body, 'unsupported_en', 'then the menu');
  assert.equal(decideTurn(item({ kind: 'unsupported', raw_type: 'reaction' }), turn({ templates: T2, state: 'echo.wait' }), flags).action, 'stop');
});

test('service log fields reach the turn record (analytics)', () => {
  const d = afterLlm(decideTurn(item({ kind: 'text', text: 'kab tak' }), turn(), flags), { ok: true, service_key: 'echo', subtype: 'repeat', slots: {}, lang: 'en', confidence: 0.9, tokens: 40 });
  const f = finalizeTurn(d, afterService(d, { messages: [{ type: 'text', body: 'x' }], next_state: null, context: {}, done: false,
    log: { subtype: 'ask_unanswered', resolved: false, llm_tokens: 900, unanswered_reason: 'qa_no_answer', detail: 'gps:<1km' } }));
  assert.equal(f.end.llm_tokens, 940, 'classifier + service tokens');
  assert.equal(f.end.unanswered_reason, 'qa_no_answer');
  assert.equal(f.end.detail, 'gps:<1km');
  assert.equal(f.end.resolved, false);
  const bad = afterService(d, { messages: [{ type: 'text', body: 'x' }], log: { llm_tokens: -1, detail: 'x'.repeat(65) } });
  assert.equal(bad.log.subtype, 'error', 'bad log fields break the contract');
});

test('helpers', () => {
  assert.deepEqual(splitContext({ a: 1, __core: { x: 1 } }), { service: { a: 1 }, core: { x: 1 } });
  assert.deepEqual(splitContext(null), { service: {}, core: {} });
  assert.equal(istNow(new Date(Date.UTC(2026, 0, 1, 0, 0))), '2026-01-01 05:30');
});
