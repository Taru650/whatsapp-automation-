// Builds the citizen-facing WhatsApp message for a complaint status change.
// Used by the notification bridge (core-11-notify-poll). Pure: given one
// grievance.notification_outbox row's payload and the citizen's language,
// returns a 'messages' array for deliverMessages() (core/deliver.js).
// Depends on: extractPhones (core/phone_guard.js), loaded in the same Code node.
//
// Always an approved WhatsApp *template*, never free text: a status change can
// come days after the citizen last wrote, outside WhatsApp's 24-hour customer
// service window, where the Cloud API still answers 200 for free text but
// Meta drops it later (error 131047) - the citizen would silently never hear.
// The template must exist in Meta's WhatsApp Manager in both languages
// (docs/runbook.md, "Complaint status template"), with three body variables:
//   {{1}} complaint id   {{2}} status   {{3}} note
const STATUS_LABEL = {
  open: { en: 'Open', hi: 'खुला' },
  assigned: { en: 'Assigned to an officer', hi: 'अधिकारी को सौंपी गई' },
  in_progress: { en: 'In progress', hi: 'प्रक्रिया में' },
  resolved: { en: 'Resolved', hi: 'हल हो गई' },
  closed: { en: 'Resolved and closed', hi: 'हल होकर बंद' },
};

const DEFAULT_NOTE = {
  assigned: { en: 'An officer will look into it.', hi: 'एक अधिकारी इसे देखेंगे।' },
  in_progress: { en: 'Work on it has started.', hi: 'इस पर काम शुरू हो गया है।' },
  resolved: { en: 'The issue has been resolved.', hi: 'समस्या का समाधान कर दिया गया है।' },
  closed: { en: 'The issue has been resolved.', hi: 'समस्या का समाधान कर दिया गया है।' },
};

const NOTE_MAX = 300;

function notifyLang(lang) {
  return lang === 'en' ? 'en' : 'hi';
}

function statusLabel(status, lang) {
  return (STATUS_LABEL[status] || {})[notifyLang(lang)] || status;
}

// Meta rejects template variables that are empty or contain newlines, tabs or
// more than four spaces in a row.
function templateParam(s) {
  return String(s == null ? '' : s).replace(/\s+/g, ' ').trim();
}

// The closing officer's own words, if they are safe to show: template text is
// not checked by deliver.js's phone guard (it only reads text/interactive
// bodies), so any phone-number-like run here drops the remark entirely rather
// than let an unverified number reach a citizen.
function citizenNote(payload, lang) {
  const l = notifyLang(lang);
  const fallback = ((DEFAULT_NOTE[payload.status] || {})[l]) || '-';
  const remark = templateParam(payload.remark);
  if (!remark) return fallback;
  if (typeof extractPhones !== 'function' || extractPhones(remark).length) return fallback;
  const chars = Array.from(remark);
  return chars.length > NOTE_MAX ? `${chars.slice(0, NOTE_MAX - 1).join('')}…` : remark;
}

// payload: { complaint_id, status, remark? } (grievance.notification_outbox.payload)
// opts.template: the approved template's name (COMPLAINT_UPDATE_TEMPLATE).
function buildStatusNotification(payload, lang, opts = {}) {
  const p = payload || {};
  if (!p.complaint_id || !STATUS_LABEL[p.status]) throw new Error(`bad notification payload: ${JSON.stringify(p).slice(0, 200)}`);
  const l = notifyLang(lang);
  return [{
    type: 'template',
    template: {
      name: opts.template || 'complaint_update',
      language: { code: l },
      components: [{ type: 'body', parameters: [
        { type: 'text', text: templateParam(p.complaint_id) },
        { type: 'text', text: statusLabel(p.status, l) },
        { type: 'text', text: citizenNote(p, l) },
      ] }],
    },
  }];
}

// The officer's proof photo after a closing update, as a normal image message
// (allowed only within 24 h of the citizen's last message; the poll checks that).
// The caption repeats the officer's note, so the citizen still gets it when the
// template itself could not be delivered (e.g. not approved by Meta yet).
function buildClosurePhoto(payload, lang, mediaId) {
  const p = payload || {};
  const l = notifyLang(lang);
  const head = l === 'en' ? `📷 Photo of the work done – complaint ${p.complaint_id}` : `📷 किए गए काम की फ़ोटो – शिकायत ${p.complaint_id}`;
  const label = l === 'en' ? "Officer's remark" : 'अधिकारी की टिप्पणी';
  return [{ type: 'image', media_id: mediaId, caption: `${head}\n${label}: ${citizenNote(p, l)}` }];
}

if (typeof module !== 'undefined') module.exports = { buildStatusNotification, buildClosurePhoto, statusLabel, citizenNote, NOTE_MAX };
