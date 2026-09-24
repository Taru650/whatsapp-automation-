// svc_template: copy this file (and n8n/src/workflows/svc-template.mjs) to start a
// new citizen service. See docs/adding-a-service.md.
//
// The router calls handle(req) with:
//   req = { wa_hash, lang: 'hi'|'en', state, context, now_iso, now_ist, is_admin,
//           input: { kind: 'open'|'text'|'button'|'list'|'location', id, text, lat, lon,
//                    intent?: { subtype, slots } } }
// and expects:
//   { messages: [...], next_state: '<prefix>.<state>' | null, context: {...},
//     done: boolean, log: { subtype, resolved } }
// Rules: never call WhatsApp yourself; every button/list id starts with '<prefix>:'
// (or 'core:menu'); answer '<prefix>:open' with your service menu; facts and phone
// numbers only from your own DB tables.
const PREFIX = 'tmpl';

function templateHandle(req) {
  const hi = req.lang === 'hi';
  return {
    messages: [{
      type: 'buttons',
      body: hi ? 'यह एक नमूना सेवा है।' : 'This is a template service.',
      buttons: [{ id: 'core:menu', title: hi ? '🏠 मेनू' : '🏠 Menu' }],
    }],
    next_state: null,
    context: {},
    done: false,
    log: { subtype: 'open', resolved: true },
  };
}

if (typeof module !== 'undefined') module.exports = { templateHandle, PREFIX };
