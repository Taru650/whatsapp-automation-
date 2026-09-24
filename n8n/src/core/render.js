// Contract messages -> WhatsApp Cloud API payloads, enforcing Meta's field
// limits. Meta rejects the WHOLE message if any field is too long, so we
// truncate here rather than lose the reply.
const LIMITS = {
  text: 4096,
  body: 1024,         // interactive body
  buttonTitle: 20,
  maxButtons: 3,
  listButton: 20,
  sectionTitle: 24,
  rowTitle: 24,
  rowDescription: 72,
  maxRows: 10,
  id: 256,
};

function cut(s, n) {
  const str = String(s ?? '');
  const chars = Array.from(str); // count code points, not UTF-16 units (Hindi/emoji)
  return chars.length <= n ? str : chars.slice(0, n - 1).join('') + '…';
}

// Split long text at paragraph/line boundaries so each part fits.
function splitText(text, max = LIMITS.text) {
  const parts = [];
  let rest = String(text ?? '');
  while (Array.from(rest).length > max) {
    const chars = Array.from(rest);
    const window = chars.slice(0, max).join('');
    let at = window.lastIndexOf('\n\n');
    if (at < max / 2) at = window.lastIndexOf('\n');
    if (at < max / 2) at = window.lastIndexOf(' ');
    if (at <= 0) at = window.length;
    parts.push(window.slice(0, at).trimEnd());
    rest = rest.slice(at).trimStart();
  }
  if (rest.length || parts.length === 0) parts.push(rest);
  return parts;
}

function renderMessage(msg, to) {
  const base = { messaging_product: 'whatsapp', recipient_type: 'individual', to };
  switch (msg.type) {
    case 'text':
      return splitText(msg.body).map((body) => ({ ...base, type: 'text', text: { body, preview_url: true } }));
    case 'buttons':
      return [{
        ...base,
        type: 'interactive',
        interactive: {
          type: 'button',
          body: { text: cut(msg.body, LIMITS.body) },
          action: {
            buttons: (msg.buttons || []).slice(0, LIMITS.maxButtons).map((b) => ({
              type: 'reply',
              reply: { id: cut(b.id, LIMITS.id), title: cut(b.title, LIMITS.buttonTitle) },
            })),
          },
        },
      }];
    case 'list': {
      let remaining = LIMITS.maxRows;
      const sections = [];
      for (const s of msg.sections || []) {
        if (remaining <= 0) break;
        const rows = (s.rows || []).slice(0, remaining).map((r) => {
          const row = { id: cut(r.id, LIMITS.id), title: cut(r.title, LIMITS.rowTitle) };
          if (r.description) row.description = cut(r.description, LIMITS.rowDescription);
          return row;
        });
        remaining -= rows.length;
        if (rows.length) sections.push({ title: cut(s.title || '', LIMITS.sectionTitle), rows });
      }
      return [{
        ...base,
        type: 'interactive',
        interactive: {
          type: 'list',
          body: { text: cut(msg.body, LIMITS.body) },
          action: { button: cut(msg.button || 'Menu', LIMITS.listButton), sections },
        },
      }];
    }
    case 'location':
      return [{
        ...base,
        type: 'location',
        location: { latitude: msg.lat, longitude: msg.lon, name: msg.name || '', address: msg.address || '' },
      }];
    case 'location_request':
      return [{
        ...base,
        type: 'interactive',
        interactive: { type: 'location_request_message', body: { text: cut(msg.body, LIMITS.body) }, action: { name: 'send_location' } },
      }];
    case 'template':
      return [{ ...base, type: 'template', template: msg.template }];
    default:
      throw new Error(`unknown message type: ${msg.type}`);
  }
}

// All user-visible strings in a payload (for the phone guard and logging).
function visibleText(payload) {
  const out = [];
  if (payload.text) out.push(payload.text.body);
  const i = payload.interactive;
  if (i) {
    out.push(i.body && i.body.text);
    for (const b of (i.action && i.action.buttons) || []) out.push(b.reply.title);
    for (const s of (i.action && i.action.sections) || []) {
      out.push(s.title);
      for (const r of s.rows) out.push(r.title, r.description);
    }
  }
  if (payload.location) out.push(payload.location.name, payload.location.address);
  return out.filter(Boolean).join('\n');
}

if (typeof module !== 'undefined') module.exports = { renderMessage, splitText, visibleText, cut, LIMITS };
