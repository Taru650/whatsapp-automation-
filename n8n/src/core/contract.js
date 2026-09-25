// Service contract validation. A service output that breaks the contract is
// never sent; the router replies with an apology and alerts the admins.
const MESSAGE_TYPES = new Set(['text', 'buttons', 'list', 'location', 'location_request']);
const SHARED_ID_PREFIXES = ['core:', 'lang:', 'fb:'];

function idAllowed(id, prefix) {
  return typeof id === 'string' && (id.startsWith(`${prefix}:`) || SHARED_ID_PREFIXES.some((p) => id.startsWith(p)));
}

function validateServiceOutput(out, prefix) {
  const errors = [];
  if (!out || typeof out !== 'object') return ['output is not an object'];
  if (!Array.isArray(out.messages)) errors.push('messages must be an array');
  for (const [i, m] of (out.messages || []).entries()) {
    if (!m || !MESSAGE_TYPES.has(m.type)) { errors.push(`messages[${i}].type invalid`); continue; }
    if ((m.type === 'text' || m.type === 'buttons' || m.type === 'list' || m.type === 'location_request') && !m.body) {
      errors.push(`messages[${i}].body missing`);
    }
    if (m.type === 'buttons') {
      if (!Array.isArray(m.buttons) || m.buttons.length < 1 || m.buttons.length > 3) errors.push(`messages[${i}] needs 1-3 buttons`);
      for (const b of m.buttons || []) if (!idAllowed(b.id, prefix)) errors.push(`messages[${i}] button id "${b.id}" outside prefix "${prefix}"`);
    }
    if (m.type === 'list') {
      const rows = (m.sections || []).flatMap((s) => s.rows || []);
      if (rows.length < 1 || rows.length > 10) errors.push(`messages[${i}] needs 1-10 list rows`);
      for (const r of rows) if (!idAllowed(r.id, prefix)) errors.push(`messages[${i}] row id "${r.id}" outside prefix "${prefix}"`);
    }
    if (m.type === 'location' && (typeof m.lat !== 'number' || typeof m.lon !== 'number')) errors.push(`messages[${i}] location needs numeric lat/lon`);
  }
  if (out.next_state != null && !(typeof out.next_state === 'string' && out.next_state.startsWith(`${prefix}.`))) {
    errors.push(`next_state "${out.next_state}" must start with "${prefix}."`);
  }
  if (out.context != null && (typeof out.context !== 'object' || Array.isArray(out.context))) errors.push('context must be an object');
  if (out.done != null && typeof out.done !== 'boolean') errors.push('done must be boolean');
  // log: { subtype?, resolved?, detail?, llm_tokens?, unanswered_reason? } feeds analytics
  const log = out.log;
  if (log != null) {
    if (typeof log !== 'object' || Array.isArray(log)) errors.push('log must be an object');
    else {
      for (const k of ['subtype', 'detail', 'unanswered_reason']) {
        if (log[k] != null && (typeof log[k] !== 'string' || log[k].length > 64)) errors.push(`log.${k} must be a string of at most 64 chars`);
      }
      if (log.llm_tokens != null && !(Number.isInteger(log.llm_tokens) && log.llm_tokens >= 0)) errors.push('log.llm_tokens must be a non-negative integer');
    }
  }
  return errors;
}

if (typeof module !== 'undefined') module.exports = { validateServiceOutput, idAllowed };
