// Free-text intent classifier (Claude Haiku 4.5 via the Messages API with
// structured outputs). The LLM only picks a route; it never produces facts,
// numbers or eligibility verdicts that reach the citizen.
const DEFAULT_MODEL = 'claude-haiku-4-5';
const CONFIDENCE_THRESHOLD = 0.6;
const SLOT_KEYS = ['place', 'category', 'date', 'block', 'department'];

function classifierSystemPrompt(services) {
  const lines = services.map((s) => {
    const subtypes = Object.entries(s.subtypes || {}).map(([k, v]) => `    - ${k}: ${v}`).join('\n');
    return `- service_key "${s.service_key}": ${s.intent_hint_en || s.title_en}` + (subtypes ? `\n  subtypes:\n${subtypes}` : '');
  }).join('\n');
  return [
    'You route messages sent by citizens to a district administration WhatsApp helpline in Bihar, India.',
    'Messages may be in Hindi (Devanagari), Hinglish (Hindi in Latin script) or English, often short and with typos.',
    'Pick the single service that can answer the message, and the best matching subtype of that service.',
    'If no service fits, or the message is chit-chat or abuse, use service_key "none".',
    'Fill slots only with words present in the message (e.g. a place or category name); use "" otherwise.',
    'confidence is your probability (0 to 1) that the chosen service and subtype are right.',
    'lang is "hi" if the citizen wrote Hindi or Hinglish, otherwise "en".',
    '',
    'Available services:',
    lines,
  ].join('\n');
}

function classifierSchema(services) {
  const keys = services.map((s) => s.service_key).concat(['none']);
  const slotProps = Object.fromEntries(SLOT_KEYS.map((k) => [k, { type: 'string' }]));
  return {
    type: 'object',
    properties: {
      service_key: { type: 'string', enum: keys },
      subtype: { type: 'string' },
      slots: { type: 'object', properties: slotProps, required: SLOT_KEYS, additionalProperties: false },
      lang: { type: 'string', enum: ['hi', 'en'] },
      confidence: { type: 'number' },
    },
    required: ['service_key', 'subtype', 'slots', 'lang', 'confidence'],
    additionalProperties: false,
  };
}

function buildClassifierRequest(text, services, model) {
  return {
    model: model || DEFAULT_MODEL,
    max_tokens: 300,
    temperature: 0,
    system: classifierSystemPrompt(services),
    messages: [{ role: 'user', content: String(text).slice(0, 1000) }],
    output_config: { format: { type: 'json_schema', schema: classifierSchema(services) } },
  };
}

// Returns { ok, service_key, subtype, slots, lang, confidence, tokens, reason }.
function parseClassifierResponse(resp, services, threshold = CONFIDENCE_THRESHOLD) {
  const none = (reason, extra = {}) => ({ ok: false, service_key: 'none', subtype: null, slots: {}, reason, tokens: 0, ...extra });
  if (!resp || resp.error) return none('api_error');
  const tokens = ((resp.usage || {}).input_tokens || 0) + ((resp.usage || {}).output_tokens || 0);
  if (resp.stop_reason !== 'end_turn') return none(`stop_${resp.stop_reason}`, { tokens });
  const block = (resp.content || []).find((b) => b.type === 'text');
  let data;
  try {
    data = JSON.parse(block.text);
  } catch (e) {
    return none('bad_json', { tokens });
  }
  const known = new Set(services.map((s) => s.service_key));
  if (!known.has(data.service_key)) return none('no_service', { tokens, lang: data.lang });
  if (!(Number(data.confidence) >= threshold)) return none('low_confidence', { tokens, lang: data.lang, confidence: data.confidence });
  const slots = Object.fromEntries(Object.entries(data.slots || {}).filter(([, v]) => v));
  return { ok: true, service_key: data.service_key, subtype: data.subtype || null, slots, lang: data.lang, confidence: Number(data.confidence), tokens, reason: null };
}

if (typeof module !== 'undefined') {
  module.exports = { buildClassifierRequest, parseClassifierResponse, classifierSchema, classifierSystemPrompt, DEFAULT_MODEL, CONFIDENCE_THRESHOLD };
}
