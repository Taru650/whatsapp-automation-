// Decide what to do with one normalised inbound message.
// Precedence (first match wins):
//   unsupported type -> global command -> core ids (core:/lang:/fb:) ->
//   service id prefix -> location handler -> session state owner ->
//   free text -> LLM (if enabled) -> main menu
const GLOBAL_COMMANDS = new Set([
  'hi', 'hii', 'hello', 'hey', 'helo', 'namaste', 'namaskar', 'menu', 'start', 'help', '0', 'home',
  'नमस्ते', 'नमस्कार', 'हेलो', 'हाय', 'मेनू', 'मेन्यू', 'शुरू',
]);
const LANG_COMMANDS = { english: 'en', 'अंग्रेज़ी': 'en', 'अंग्रेजी': 'en', hindi: 'hi', 'हिंदी': 'hi', 'हिन्दी': 'hi' };

function normText(text) {
  return String(text || '').trim().toLowerCase().replace(/[!.?।\s]+$/u, '');
}

function prefixOf(value, sep) {
  if (!value) return null;
  const i = value.indexOf(sep);
  return i > 0 ? value.slice(0, i) : null;
}

// Service whose registry keyword appears in the text (Latin: whole word;
// Devanagari: substring, since Hindi words take suffixes). Lower menu_order wins.
function keywordService(services, text) {
  const t = ` ${String(text || '').toLowerCase().replace(/[^\p{L}\p{M}\p{N}]+/gu, ' ')} `;
  const sorted = (services || []).slice().sort((a, b) => (a.menu_order || 0) - (b.menu_order || 0));
  for (const s of sorted) {
    for (const k of s.keywords || []) {
      const kw = String(k).toLowerCase().trim();
      if (!kw) continue;
      if (/[\u0900-\u097F]/.test(kw) ? t.includes(kw) : t.includes(` ${kw} `)) return s;
    }
  }
  return null;
}

function decideRoute({ input, state, services, isAdmin, llmEnabled }) {
  const svcByPrefix = new Map((services || []).map((s) => [s.id_prefix, s]));

  if (input.kind === 'unsupported') return { action: 'unsupported' };

  if (input.kind === 'text') {
    const t = normText(input.text);
    if (GLOBAL_COMMANDS.has(t)) return { action: 'menu' };
    if (LANG_COMMANDS[t]) return { action: 'lang', lang: LANG_COMMANDS[t] };
  }

  if (input.id) {
    const id = input.id;
    if (id === 'core:menu') return { action: 'menu' };
    if (id.startsWith('lang:')) return { action: 'lang', lang: id.slice(5) === 'hi' ? 'hi' : 'en' };
    if (id.startsWith('fb:')) {
      const [, vote, svc] = id.split(':');
      return { action: 'feedback', rating: vote === 'up' ? 1 : -1, service_key: svc || null };
    }
    const svc = svcByPrefix.get(prefixOf(id, ':'));
    if (svc) {
      if (id.split(':')[1] === 'adm' && !isAdmin) return { action: 'not_allowed' };
      return { action: 'service', service: svc };
    }
    return { action: 'menu', reason: 'stale_id' }; // button from a disabled/unknown service
  }

  const stateOwner = svcByPrefix.get(prefixOf(state, '.'));

  if (input.kind === 'location') {
    if (stateOwner && stateOwner.accepts_location) return { action: 'service', service: stateOwner };
    const handler = (services || []).find((s) => s.accepts_location);
    return handler ? { action: 'service', service: handler } : { action: 'menu' };
  }

  if (stateOwner) return { action: 'service', service: stateOwner };

  if (input.kind === 'text' && input.text) {
    const byKeyword = keywordService(services, input.text);
    if (byKeyword) return { action: 'service', service: byKeyword, via: 'keyword' };
    return llmEnabled ? { action: 'llm' } : { action: 'menu', reason: 'no_llm' };
  }
  return { action: 'menu' };
}

if (typeof module !== 'undefined') module.exports = { decideRoute, keywordService, GLOBAL_COMMANDS, normText };
