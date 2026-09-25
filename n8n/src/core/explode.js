// Split one Meta webhook POST into one item per inbound message.
// Meta can batch several entries/changes/messages in a single delivery, and
// sends delivery/read receipts ("statuses") which we drop here.
function explodeWebhook(body) {
  const out = [];
  if (!body || body.object !== 'whatsapp_business_account') return out;
  for (const entry of body.entry || []) {
    for (const change of entry.changes || []) {
      if (change.field !== 'messages') continue;
      const value = change.value || {};
      const contacts = value.contacts || [];
      for (const message of value.messages || []) {
        const contact = contacts.find((c) => c.wa_id === message.from) || contacts[0] || {};
        out.push({
          wa_id: message.from,
          msg_id: message.id,
          timestamp: message.timestamp,
          phone_number_id: (value.metadata || {}).phone_number_id,
          message,
        });
      }
    }
  }
  return out;
}

if (typeof module !== 'undefined') module.exports = { explodeWebhook };
