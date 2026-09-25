// Render -> phone guard -> WhatsApp Cloud API, strictly one message after
// another (awaiting each response) so a citizen's messages arrive in order.
// Returns one log entry per payload for core.rpc_finish_turn().
// Depends on: renderMessage/visibleText (render.js), extractPhones (phone_guard.js).
// `allowed` = normalised numbers from core.number_registry; `http` = this.helpers.httpRequest.
function normDigits(p) {
  const d = String(p || '').replace(/\D/g, '');
  return /^91[6-9]\d{9}$/.test(d) ? d.slice(2) : d;
}

async function deliverMessages(send, allowed, cfg, http) {
  const ok = new Set((allowed || []).map(normDigits));
  const url = `${cfg.base || 'https://graph.facebook.com'}/${cfg.version || 'v23.0'}/${cfg.phoneId}/messages`;
  const logs = [];
  for (const m of (send && send.messages) || []) {
    for (let payload of renderMessage(m, send.to)) {
      let text = visibleText(payload);
      let blocked = null;
      const bad = extractPhones(text).filter((p) => !ok.has(normDigits(p)));
      if (bad.length) {
        // A number that is not in the verified data must never reach a citizen.
        blocked = bad;
        text = send.lang === 'en' ? 'Sorry, this information is not available right now.' : 'माफ़ कीजिए, यह जानकारी अभी उपलब्ध नहीं है।';
        payload = { messaging_product: 'whatsapp', recipient_type: 'individual', to: send.to, type: 'text', text: { body: text } };
      }
      let result = null;
      for (let attempt = 1; attempt <= 2 && !result; attempt++) {
        try {
          const res = await http({ method: 'POST', url, json: true, body: payload, timeout: 10000,
            headers: { Authorization: `Bearer ${cfg.token}` }, returnFullResponse: true, ignoreHttpStatusErrors: true });
          const retryable = res.statusCode === 429 || res.statusCode >= 500;
          if (res.statusCode < 300) result = { out_id: ((res.body.messages || [])[0] || {}).id || null, error: null };
          else if (!retryable || attempt === 2) result = { out_id: null, error: `HTTP ${res.statusCode}: ${JSON.stringify(res.body).slice(0, 400)}` };
        } catch (e) {
          if (attempt === 2) result = { out_id: null, error: String(e.message || e).slice(0, 400) };
        }
        if (!result) await new Promise((r) => setTimeout(r, 1000));
      }
      logs.push({ wa_hash: send.wa_hash, service_key: send.service_key, kind: m.type, text,
        out_id: result.out_id, error: result.error || (blocked ? `phone_guard:${blocked.join(',')}` : null) });
    }
  }
  return logs;
}

if (typeof module !== 'undefined') module.exports = { deliverMessages, normDigits };
