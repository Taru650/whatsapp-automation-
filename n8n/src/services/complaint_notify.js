// Builds the citizen-facing WhatsApp message for a complaint status change.
// Used by the notification bridge (core-11-notify-poll, M8). Pure: given one
// grievance.notification_outbox row's payload and the citizen's language,
// returns a 'messages' array ready for core-01-send's `send.messages` - sent
// directly, not through svc_complaint, since no citizen input is involved
// (the same way core-03-admin-alert builds its own send object inline).
const STATUS_LABEL = {
  open: { en: 'Open', hi: 'खुला' },
  assigned: { en: 'Assigned', hi: 'असाइन किया गया' },
  in_progress: { en: 'In progress', hi: 'प्रक्रिया में' },
  resolved: { en: 'Resolved', hi: 'हल हो गया' },
  closed: { en: 'Closed', hi: 'बंद' },
};

function cmpT(lang, en, hi) {
  return lang === 'hi' ? hi : en;
}

function statusLabel(status, lang) {
  return (STATUS_LABEL[status] || {})[lang] || status;
}

// payload: { complaint_id, status, remark? } (grievance.notification_outbox.payload)
function buildStatusNotification(payload, lang) {
  const p = payload || {};
  const label = statusLabel(p.status, lang);
  const remarkLine = p.remark ? `\n${cmpT(lang, 'Note:', 'टिप्पणी:')} ${String(p.remark).slice(0, 500)}` : '';
  const body = cmpT(lang,
    `Update on your complaint *${p.complaint_id}*: now *${label}*.${remarkLine}`,
    `आपकी शिकायत *${p.complaint_id}* पर अपडेट: अब *${label}*।${remarkLine}`);
  return [{ type: 'text', body }];
}

if (typeof module !== 'undefined') module.exports = { buildStatusNotification, statusLabel };
