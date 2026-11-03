// svc_complaint: complaint registration and status-check over WhatsApp.
//
// complaintHandle(req, snap) is pure: `snap` is svc_complaint.snapshot(wa_hash)
// (categories, this citizen's own complaints, the geofence setting) loaded by
// the workflow right before this runs. Media (photo/PDF) is already
// downloaded by the workflow before this is called: a successful image/
// document input carries { media_path, media_mime, media_kind, media_sha256 };
// a failed one carries { media_error }. This keeps complaintHandle itself
// free of fs/network access, same as melaHandle.
//
// Returns the service contract output, plus optionally
//   effects: [{ type: 'create_complaint', category_key, description, lang,
//               lat, lon, evidence: [{path, mime, kind, sha256}] }]
// applied by the workflow (svc_complaint.apply_effects), which then calls
// complaintReceiptMessage() for the real confirmation text (the complaint_id
// does not exist until that DB call runs) - the same two-phase pattern Mela
// uses for its LLM Q&A (melaHandle -> DB/LLM call -> melaQaFinish).
//
// Location is mandatory, never optional, and never derived from a photo's
// EXIF data (WhatsApp strips it): it is what the geofence check and future
// officer-routing are built on.

const MAX_EVIDENCE = 5;
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

function normalise(s) {
  return String(s || '').toLowerCase().replace(/[^\p{L}\p{M}\p{N}\s]/gu, ' ').replace(/\s+/g, ' ').trim();
}

function menuBtn(lang) {
  return { id: 'core:menu', title: cmpT(lang, '🏠 Menu', '🏠 मेनू') };
}

function labelFor(c, lang) {
  return (lang === 'hi' && c.label_hi) || c.label_en || c.label_hi || c.category_key;
}

function statusLabel(status, lang) {
  return (STATUS_LABEL[status] || {})[lang] || status;
}

// Same formula as mela.js's haversineM, duplicated here on purpose: services
// are independent files and this one must not depend on another service.
function haversineM(lat1, lon1, lat2, lon2) {
  const R = 6371000;
  const toRad = (x) => (x * Math.PI) / 180;
  const dLat = toRad(lat2 - lat1);
  const dLon = toRad(lon2 - lon1);
  const a = Math.sin(dLat / 2) ** 2 + Math.cos(toRad(lat1)) * Math.cos(toRad(lat2)) * Math.sin(dLon / 2) ** 2;
  return 2 * R * Math.asin(Math.sqrt(a));
}

// ---- screens ----------------------------------------------------------------
function openMenu(req) {
  const lang = req.lang;
  return {
    messages: [{
      type: 'buttons',
      body: cmpT(lang, '🗒️ *Complaints*\nFile a new complaint or check an existing one.', '🗒️ *शिकायत*\nनई शिकायत दर्ज करें या मौजूदा की स्थिति देखें।'),
      buttons: [{ id: 'cmp:new', title: cmpT(lang, '📝 New complaint', '📝 नई शिकायत') },
                { id: 'cmp:mine', title: cmpT(lang, '📋 My complaints', '📋 मेरी शिकायतें') }, menuBtn(lang)],
    }],
    next_state: null, context: {}, done: false, log: { subtype: 'open', resolved: true },
  };
}

function categoryMenu(req, snap, page) {
  const lang = req.lang;
  const cats = snap.categories || [];
  if (!cats.length) return { ...openMenu(req), messages: [{ type: 'text', body: cmpT(lang, 'Complaint categories are not set up yet.', 'शिकायत श्रेणियाँ अभी सेट नहीं हैं।') }] };
  const per = 9;
  const slice = cats.slice(page * per, page * per + per);
  const rows = slice.map((c) => ({ id: `cmp:cat:${c.category_key}`, title: labelFor(c, lang).slice(0, 24) }));
  if (cats.length > (page + 1) * per) rows.push({ id: `cmp:catpage:${page + 1}`, title: cmpT(lang, 'More ▸', 'अधिक ▸') });
  return {
    messages: [{ type: 'list', body: cmpT(lang, 'What is the complaint about?', 'शिकायत किस बारे में है?'),
      button: cmpT(lang, 'Choose', 'चुनें'), sections: [{ title: cmpT(lang, 'Categories', 'श्रेणियाँ'), rows }] }],
    next_state: null, context: {}, done: false, log: { subtype: 'category_menu', resolved: true },
  };
}

function describePrompt(req, categoryKey, categoryLabel) {
  const lang = req.lang;
  return {
    messages: [{ type: 'text', body: cmpT(lang, 'Please describe the issue in your own words.', 'कृपया समस्या को अपने शब्दों में बताएं।') }],
    next_state: 'cmp.describe', context: { category_key: categoryKey, category_label: categoryLabel }, done: false,
    log: { subtype: 'describe_prompt', resolved: true },
  };
}

function evidencePrompt(req, ctx) {
  const lang = req.lang;
  return {
    messages: [{ type: 'text', body: cmpT(lang,
      'Now send at least one photo of the issue (required). You can send up to 5. Type *done* when finished.',
      'अब समस्या की कम से कम एक फ़ोटो भेजें (आवश्यक)। आप अधिकतम 5 भेज सकते हैं। पूरा होने पर *done* लिखें।') }],
    next_state: 'cmp.evidence', context: ctx, done: false, log: { subtype: 'evidence_prompt', resolved: true },
  };
}

function evidenceNeedsPhoto(req, ctx) {
  const lang = req.lang;
  return {
    messages: [{ type: 'text', body: cmpT(lang,
      'Please send at least one photo of the issue before continuing - a photo is required to register a complaint.',
      'कृपया आगे बढ़ने से पहले समस्या की कम से कम एक फ़ोटो भेजें - शिकायत दर्ज करने के लिए फ़ोटो आवश्यक है।') }],
    next_state: 'cmp.evidence', context: ctx, done: false, log: { subtype: 'evidence_missing', resolved: false },
  };
}

const MEDIA_ERROR_MESSAGES = {
  unsupported_mime: { en: 'I can only accept a photo (JPG/PNG) or a PDF. Please try again.', hi: 'मैं केवल फ़ोटो (JPG/PNG) या PDF स्वीकार कर सकता/सकती हूँ। कृपया फिर से भेजें।' },
  too_large: { en: 'That file is too large (max 10 MB). Please send a smaller photo.', hi: 'यह फ़ाइल बहुत बड़ी है (अधिकतम 10 MB)। कृपया छोटी फ़ोटो भेजें।' },
};

function evidenceError(req, ctx, errorCode) {
  const lang = req.lang;
  const m = MEDIA_ERROR_MESSAGES[errorCode];
  const body = m ? cmpT(lang, m.en, m.hi) : cmpT(lang, 'Sorry, that file could not be received. Please try again.', 'माफ़ कीजिए, वह फ़ाइल प्राप्त नहीं हो सकी। कृपया फिर से भेजें।');
  return { messages: [{ type: 'text', body }], next_state: 'cmp.evidence', context: ctx, done: false,
    log: { subtype: 'evidence_error', resolved: false, detail: String(errorCode).slice(0, 64) } };
}

function addEvidence(req, ctx, input) {
  const lang = req.lang;
  const list = (ctx.evidence || []).slice();
  const doneBtn = { id: 'cmp:evidence:done', title: cmpT(lang, '✅ Done', '✅ हो गया') };
  if (list.length >= MAX_EVIDENCE) {
    return { messages: [{ type: 'buttons', body: cmpT(lang, 'You already added the maximum of 5 files.', 'आपने अधिकतम 5 फ़ाइलें जोड़ दी हैं।'), buttons: [doneBtn] }],
      next_state: 'cmp.evidence', context: { ...ctx, evidence: list }, done: false, log: { subtype: 'evidence_full', resolved: true } };
  }
  list.push({ path: input.media_path, mime: input.media_mime, kind: input.media_kind, sha256: input.media_sha256 });
  const body = cmpT(lang, `Added (${list.length}/5). Send another photo, or tap Done.`, `जोड़ा गया (${list.length}/5)। और फ़ोटो भेजें या Done दबाएँ।`);
  return { messages: [{ type: 'buttons', body, buttons: [doneBtn] }],
    next_state: 'cmp.evidence', context: { ...ctx, evidence: list }, done: false, log: { subtype: 'evidence_added', resolved: true } };
}

function locationPrompt(req, ctx) {
  const lang = req.lang;
  return {
    messages: [{ type: 'location_request', body: cmpT(lang,
      'Now share your current location (tap *Send location*) - this is required so the right department and officer can find the spot.',
      'अब अपनी वर्तमान लोकेशन भेजें (*Send location* दबाएँ) - सही विभाग व अधिकारी तक पहुँचने के लिए यह आवश्यक है।') }],
    next_state: 'cmp.location', context: ctx, done: false, log: { subtype: 'location_prompt', resolved: true },
  };
}

function confirmScreen(req, ctx) {
  const lang = req.lang;
  const lines = [
    `${cmpT(lang, '*Category:*', '*श्रेणी:*')} ${ctx.category_label || ctx.category_key}`,
    `${cmpT(lang, '*Description:*', '*विवरण:*')} ${ctx.description}`,
    `${cmpT(lang, '*Photos attached:*', '*जोड़ी गई फ़ोटो:*')} ${(ctx.evidence || []).length}`,
  ];
  const body = `${cmpT(lang, 'Please confirm your complaint:', 'कृपया अपनी शिकायत की पुष्टि करें:')}\n\n${lines.join('\n')}`;
  return {
    messages: [{ type: 'buttons', body, buttons: [
      { id: 'cmp:confirm', title: cmpT(lang, '✅ Submit', '✅ दर्ज करें') },
      { id: 'cmp:edit', title: cmpT(lang, '✏️ Edit', '✏️ संपादित करें') },
      menuBtn(lang),
    ] }],
    next_state: 'cmp.confirm', context: ctx, done: false, log: { subtype: 'confirm', resolved: true },
  };
}

function locationReceived(req, snap, ctx, input) {
  const lang = req.lang;
  const geo = snap.geofence || {};
  const enabled = geo.enabled === true || geo.enabled === 'true';
  if (enabled) {
    const num = (v) => (v === null || v === undefined || v === '' ? NaN : Number(v)); // Number(null) is 0
    const centerLat = num(geo.center_lat);
    const centerLon = num(geo.center_lon);
    const radius = Number(geo.radius_m) || 500;
    if (Number.isFinite(centerLat) && Number.isFinite(centerLon)) {
      const d = haversineM(input.lat, input.lon, centerLat, centerLon);
      if (d > radius) {
        return {
          messages: [{ type: 'text', body: cmpT(lang,
            'Complaints can only be filed from inside the Mela ground. Please visit the nearest help desk, or move closer and share your location again.',
            'शिकायत केवल मेला परिसर के भीतर से ही दर्ज की जा सकती है। कृपया नज़दीकी सहायता केंद्र जाएँ, या पास आकर फिर से लोकेशन भेजें।') }],
          next_state: 'cmp.location', context: ctx, done: false, log: { subtype: 'geofence_reject', resolved: false, detail: 'outside' },
        };
      }
    }
  }
  return confirmScreen(req, { ...ctx, lat: input.lat, lon: input.lon });
}

function singleComplaintScreen(req, c) {
  const lang = req.lang;
  const body = cmpT(lang,
    `*${c.complaint_id}*\nStatus: ${statusLabel(c.status, lang)}\nFiled: ${c.created_at}\nLast update: ${c.updated_at}`,
    `*${c.complaint_id}*\nस्थिति: ${statusLabel(c.status, lang)}\nदर्ज: ${c.created_at}\nअंतिम अपडेट: ${c.updated_at}`);
  return {
    messages: [{ type: 'buttons', body, buttons: [{ id: 'cmp:mine', title: cmpT(lang, '📋 All my complaints', '📋 मेरी सभी शिकायतें') }, menuBtn(lang)] }],
    next_state: null, context: {}, done: true, log: { subtype: 'id_lookup', resolved: true },
  };
}

function myComplaintsScreen(req, snap) {
  const lang = req.lang;
  const mine = snap.my_complaints || [];
  const newBtn = { id: 'cmp:new', title: cmpT(lang, '📝 New complaint', '📝 नई शिकायत') };
  if (!mine.length) {
    return { messages: [{ type: 'buttons', body: cmpT(lang, 'You have not filed any complaints yet.', 'आपने अभी तक कोई शिकायत दर्ज नहीं की है।'), buttons: [newBtn, menuBtn(lang)] }],
      next_state: null, context: {}, done: true, log: { subtype: 'mine_empty', resolved: true } };
  }
  const lines = mine.slice(0, 10).map((c) => `• *${c.complaint_id}* — ${statusLabel(c.status, lang)} (${c.updated_at})`);
  const body = `${cmpT(lang, '*Your complaints:*', '*आपकी शिकायतें:*')}\n${lines.join('\n')}`;
  return { messages: [{ type: 'buttons', body, buttons: [newBtn, menuBtn(lang)] }],
    next_state: null, context: {}, done: true, log: { subtype: 'mine', resolved: true } };
}

// ---- entry point --------------------------------------------------------------
function complaintHandle(req, snap) {
  const s = snap || {};
  s.categories = s.categories || [];
  s.my_complaints = s.my_complaints || [];
  const input = req.input || {};
  const ctx = req.context || {};
  const id = input.id || '';
  const lang = req.lang === 'en' ? 'en' : 'hi';
  const r = { ...req, lang };

  // Button / list ids
  if (id === 'cmp:open') return openMenu(r);
  if (id === 'cmp:new') return categoryMenu(r, s, 0);
  if (id === 'cmp:mine') return myComplaintsScreen(r, s);
  let m = /^cmp:catpage:(\d+)$/.exec(id);
  if (m) return categoryMenu(r, s, Number(m[1]));
  m = /^cmp:cat:(.+)$/.exec(id);
  if (m) {
    const cat = s.categories.find((c) => c.category_key === m[1]);
    return cat ? describePrompt(r, cat.category_key, labelFor(cat, lang)) : categoryMenu(r, s, 0);
  }
  if (id === 'cmp:evidence:done') {
    if (req.state !== 'cmp.evidence') return openMenu(r);
    return (ctx.evidence || []).length ? locationPrompt(r, ctx) : evidenceNeedsPhoto(r, ctx);
  }
  if (id === 'cmp:edit') {
    return ctx.category_key ? describePrompt(r, ctx.category_key, ctx.category_label) : openMenu(r);
  }
  if (id === 'cmp:confirm') {
    if (req.state !== 'cmp.confirm' || !ctx.category_key || !ctx.description || typeof ctx.lat !== 'number') return openMenu(r);
    return {
      messages: [], next_state: null, context: {}, done: true, log: { subtype: 'register', resolved: true },
      effects: [{ type: 'create_complaint', category_key: ctx.category_key, description: ctx.description,
                  lang, lat: ctx.lat, lon: ctx.lon, evidence: ctx.evidence || [] }],
    };
  }
  if (input.kind === 'open' || id) return openMenu(r); // stale or unknown cmp id

  // State-specific input
  if (req.state === 'cmp.describe') {
    if (input.kind === 'text' && input.text && input.text.trim()) {
      return evidencePrompt(r, { ...ctx, description: input.text.trim().slice(0, 1000) });
    }
    return { messages: [{ type: 'text', body: cmpT(lang, 'Please type a short description of the issue.', 'कृपया समस्या का संक्षेप में विवरण लिखें।') }],
      next_state: 'cmp.describe', context: ctx, done: false, log: { subtype: 'describe_reprompt', resolved: false } };
  }
  if (req.state === 'cmp.evidence') {
    if (input.kind === 'image' || input.kind === 'document') {
      return input.media_error ? evidenceError(r, ctx, input.media_error) : addEvidence(r, ctx, input);
    }
    if (input.kind === 'text') {
      const t = normalise(input.text);
      if (t === 'done' || t === 'ho gaya' || t === 'हो गया') {
        return (ctx.evidence || []).length ? locationPrompt(r, ctx) : evidenceNeedsPhoto(r, ctx);
      }
    }
    return { messages: [{ type: 'text', body: cmpT(lang, 'Send a photo of the issue, or type *done* once you have added at least one.', 'समस्या की फ़ोटो भेजें, या कम से कम एक जोड़ने के बाद *done* लिखें।') }],
      next_state: 'cmp.evidence', context: ctx, done: false, log: { subtype: 'evidence_reprompt', resolved: false } };
  }
  if (req.state === 'cmp.location') {
    if (input.kind === 'location') return locationReceived(r, s, ctx, input);
    return { messages: [{ type: 'location_request', body: cmpT(lang, "I couldn't read a location. Please tap *Send location*.", 'लोकेशन नहीं मिली। कृपया *Send location* दबाएँ।') }],
      next_state: 'cmp.location', context: ctx, done: false, log: { subtype: 'location_reprompt', resolved: false } };
  }

  // Generic free text: a complaint id, "my complaints", or the open menu
  if (input.kind === 'text' && input.text) {
    const text = input.text.trim();
    if (/^SCB-\d{4}-C\d{5}$/i.test(text)) {
      const found = s.my_complaints.find((c) => c.complaint_id.toLowerCase() === text.toLowerCase());
      return found ? singleComplaintScreen(r, found) :
        { messages: [{ type: 'text', body: cmpT(lang, "I couldn't find that complaint ID under your number.", 'आपके नंबर पर यह शिकायत ID नहीं मिली।') }],
          next_state: null, context: {}, done: true, log: { subtype: 'id_lookup_miss', resolved: false } };
    }
    if (/(my complaint|mera shikayat|meri shikayat|मेरी शिकायत)/.test(normalise(text))) return myComplaintsScreen(r, s);
  }
  return openMenu(r);
}

// ---- second pass after apply_effects (the complaint_id does not exist until then) --------
function complaintReceiptMessage(req, complaintId) {
  const lang = req.lang === 'en' ? 'en' : 'hi';
  const mineBtn = { id: 'cmp:mine', title: cmpT(lang, '📋 My complaints', '📋 मेरी शिकायतें') };
  if (!complaintId) {
    return { messages: [{ type: 'buttons', body: cmpT(lang, 'Sorry, your complaint could not be registered right now. Please try again in a few minutes.', 'माफ़ कीजिए, आपकी शिकायत अभी दर्ज नहीं हो सकी। कृपया कुछ मिनट बाद फिर कोशिश करें।'), buttons: [menuBtn(lang)] }],
      next_state: null, context: {}, done: true, log: { subtype: 'register_failed', resolved: false } };
  }
  const body = cmpT(lang,
    `✅ Your complaint has been registered.\n*Complaint ID:* ${complaintId}\nKeep this ID to check its status later. You will get a WhatsApp message when there is an update.`,
    `✅ आपकी शिकायत दर्ज हो गई है।\n*शिकायत ID:* ${complaintId}\nस्थिति जानने के लिए इस ID को सुरक्षित रखें। अपडेट होने पर आपको WhatsApp पर सूचना मिलेगी।`);
  return { messages: [{ type: 'buttons', body, buttons: [mineBtn, menuBtn(lang)] }],
    next_state: null, context: {}, done: true, log: { subtype: 'registered', resolved: true } };
}

if (typeof module !== 'undefined') {
  module.exports = { complaintHandle, complaintReceiptMessage, haversineM, PREFIX: 'cmp' };
}
