// svc_mela: Sonpur Mela information service.
//
// melaHandle(req, snap) is pure: `snap` is svc_mela.snapshot() (all Mela data,
// a few KB) loaded by the workflow right before this runs. It returns the
// service contract output, plus optionally
//   effects:    [{ type: 'save_coords', place_id, lat, lon }]  (applied by the workflow)
//   qa_request: { question }  -> the workflow asks the LLM, then calls melaQaFinish()
// Every fact and phone number comes from `snap`; nothing is invented here.

const MELA_CATEGORY_ORDER = ['thana', 'health_centre', 'vet_camp', 'parking', 'ghat', 'accommodation',
  'toilet_water', 'lost_found', 'help_desk'];
const MELA_LABELS = {
  thana: { en: 'Police stations', hi: 'पुलिस थाना', one: { en: 'police station', hi: 'पुलिस थाना' }, icon: '👮' },
  health_centre: { en: 'Health centres', hi: 'स्वास्थ्य केंद्र', one: { en: 'health centre', hi: 'स्वास्थ्य केंद्र' }, icon: '🏥' },
  vet_camp: { en: 'Veterinary camps', hi: 'पशु चिकित्सा शिविर', one: { en: 'veterinary camp', hi: 'पशु चिकित्सा शिविर' }, icon: '🐄' },
  parking: { en: 'Parking', hi: 'पार्किंग', one: { en: 'parking', hi: 'पार्किंग' }, icon: '🅿️' },
  ghat: { en: 'Ghats', hi: 'घाट', one: { en: 'ghat', hi: 'घाट' }, icon: '🌊' },
  accommodation: { en: 'Accommodation', hi: 'ठहरने की जगह', one: { en: 'accommodation', hi: 'ठहरने की जगह' }, icon: '🏨' },
  toilet_water: { en: 'Toilets & water', hi: 'शौचालय व पानी', one: { en: 'toilet / water point', hi: 'शौचालय / पानी' }, icon: '🚻' },
  lost_found: { en: 'Lost & found', hi: 'खोया-पाया', one: { en: 'lost & found desk', hi: 'खोया-पाया केंद्र' }, icon: '🧒' },
  help_desk: { en: 'Help desks', hi: 'सहायता केंद्र', one: { en: 'help desk', hi: 'सहायता केंद्र' }, icon: 'ℹ️' },
};
// Words citizens use -> what they want. Checked on lower-cased text.
const MELA_KEYWORDS = [
  // explicit nearness only ("kahan/कहाँ" = "where" is answered with the full list)
  ['near', /\b(near|nearest|nearby|paas|pass|najdik|nazdik|nazdeek|kareeb|karib)\b|पास|नज़दीक|नजदीक|निकट|करीब/],
  ['control', /\b(control|helpline|emergency|complain|complaint|shikayat)\b|कंट्रोल|हेल्पलाइन|शिकायत|आपात/],
  ['lost_found', /\b(lost|missing|kho|khoya|kho gaya|bichhad|bichad)\b|खोया|खो गया|खो गई|बिछड़|गुम/],
  ['thana', /\b(thana|police|chowki|chauki|cop|chori|chor|theft|stolen)\b|पुलिस|थाना|चौकी|चोरी/],
  // animal words beat "doctor": "haathi ka doctor" is a vet question
  ['vet_camp', /\b(vet|veterinary|pashu|animal|cattle|cow|bail|haathi|hathi|ghoda|bakri|bhains|janwar)\b|पशु|जानवर|गाय|बैल|हाथी|घोड़ा|बकरी|भैंस/],
  ['health_centre', /\b(doctor|hospital|dispensary|medical|clinic|health|dawa|dawai|ambulance|aspatal|first aid|beemar|bimar|tabiyat)\b|अस्पताल|डॉक्टर|डाक्टर|दवा|स्वास्थ्य|एम्बुलेंस|बीमार|तबीयत/],
  ['parking', /\b(parking|park|gaadi|gadi|vehicle|car|bike)\b|पार्किंग|गाड़ी/],
  ['ghat', /\b(ghat|snan|nahana|nahane|ganga|gandak)\b|घाट|स्नान|नहान/],
  ['accommodation', /\b(hotel|stay|dharamshala|lodge|accommodation|thaharna|rukna)\b|होटल|धर्मशाला|ठहर|रुकन/],
  ['toilet_water', /\b(toilet|washroom|bathroom|urinal|water|pani|paani)\b|शौचालय|पानी/],
  ['today', /\b(today|aaj|aj|tonight|program|programme|schedule|event|show|artist|singer|performance)\b|आज|कार्यक्रम|कलाकार|प्रोग्राम/],
  ['rules', /\b(rule|rules|dos|donts|allowed|banned|mana|niyam)\b|नियम|मना|क्या करें/],
];

function melaT(lang, en, hi) {
  return lang === 'hi' ? hi : en;
}

function catLabel(snap, cat, lang, one) {
  const s = (snap && snap.settings) || {};
  const custom = s[`label_${cat}_${lang}`];
  if (custom) return custom;
  const l = MELA_LABELS[cat];
  if (!l) return cat.replace(/_/g, ' ');
  return one ? l.one[lang] : l[lang];
}

function catIcon(cat) {
  return (MELA_LABELS[cat] || {}).icon || '📍';
}

function placeName(p, lang) {
  return (lang === 'hi' && p.name_hi) || p.name_en || p.name_hi || p.id;
}

function placeLocation(p, lang) {
  return (lang === 'hi' && p.location_hi) || p.location_en || p.location_hi || '';
}

// ---- time & shifts ---------------------------------------------------------
function minutesOf(hhmm) {
  const m = /^(\d{1,2}):(\d{2})/.exec(hhmm || '');
  return m ? Number(m[1]) * 60 + Number(m[2]) : null;
}

function shiftTable(snap) {
  const s = (snap && snap.settings) || {};
  const starts = [s.shift1_start || '06:00', s.shift2_start || '14:00', s.shift3_start || '22:00'];
  return starts.map((start, i) => ({ no: i + 1, start, end: starts[(i + 1) % 3] }));
}

function currentShift(snap, nowIst) {
  const t = minutesOf((nowIst || '').slice(11, 16));
  const shifts = shiftTable(snap);
  for (const sh of shifts) {
    const a = minutesOf(sh.start);
    const b = minutesOf(sh.end);
    const inside = a <= b ? t >= a && t < b : t >= a || t < b; // shift 3 wraps past midnight
    if (inside) return sh;
  }
  return shifts[0];
}

function shiftLabel(sh, lang) {
  return melaT(lang, `Shift ${sh.no}, ${sh.start}–${sh.end}`, `पाली ${sh.no}, ${sh.start}–${sh.end}`);
}

// People on duty at a place (or control desk rows) for a shift; all-day rows always count.
function onDuty(rows, shiftNo) {
  const specific = rows.filter((d) => d.shift_no === shiftNo);
  const allDay = rows.filter((d) => d.shift_no == null);
  return specific.length ? specific.concat(allDay.filter((d) => d.person_name)) : allDay;
}

function personLine(d) {
  const phones = (d.phones || []).filter(Boolean).join(', ');
  const who = [d.person_name, d.designation].filter(Boolean).join(', ');
  if (who && phones) return `${who} – 📞 ${phones}`;
  return who || (phones ? `📞 ${phones}` : '');
}

// ---- geo --------------------------------------------------------------------
function haversineM(lat1, lon1, lat2, lon2) {
  const R = 6371000;
  const toRad = (x) => (x * Math.PI) / 180;
  const dLat = toRad(lat2 - lat1);
  const dLon = toRad(lon2 - lon1);
  const a = Math.sin(dLat / 2) ** 2 + Math.cos(toRad(lat1)) * Math.cos(toRad(lat2)) * Math.sin(dLon / 2) ** 2;
  return 2 * R * Math.asin(Math.sqrt(a));
}

function fmtDistance(m, lang) {
  const v = m < 1000 ? `${Math.max(10, Math.round(m / 10) * 10)} m` : `${(m / 1000).toFixed(1)} km`;
  return melaT(lang, `≈${v}`, `लगभग ${v}`);
}

function directionsUrl(p) {
  // No origin on purpose: Maps then follows the phone's live GPS, and the
  // citizen's own coordinates never appear in a link.
  return `https://www.google.com/maps/dir/?api=1&destination=${p.lat},${p.lon}&travelmode=walking`;
}

function hasCoords(p) {
  return typeof p.lat === 'number' && typeof p.lon === 'number';
}

// ---- text matching ------------------------------------------------------------
function normalise(s) {
  return String(s || '').toLowerCase().replace(/[^\p{L}\p{M}\p{N}\s]/gu, ' ').replace(/\s+/g, ' ').trim();
}

function detectTopic(text) {
  const t = normalise(text);
  const hits = MELA_KEYWORDS.filter(([, re]) => re.test(t)).map(([k]) => k);
  const near = hits.includes('near');
  const topic = hits.find((k) => k !== 'near') || null;
  return { near, topic };
}

// Best place whose name appears in the text (or the text in its name).
// Names repeat across categories ("Kali Ghat" is a thana, a health centre and a
// ghat); with requireCoords only places usable as a map origin are considered.
function matchPlace(snap, text, requireCoords) {
  const t = ` ${normalise(text)} `;
  if (t.trim().length < 3) return null;
  let best = null;
  for (const p of snap.places || []) {
    if (requireCoords && !hasCoords(p)) continue;
    for (const n of [p.name_en, p.name_hi, p.location_en]) {
      const name = normalise(n).replace(/\b(thana|ghat|parking|camp|ward)\b/g, ' ').replace(/\s+/g, ' ').trim();
      if (name.length < 3) continue;
      if (t.includes(` ${name} `) || (t.trim().length >= 4 && name.includes(t.trim()))) {
        const score = name.length;
        if (!best || score > best.score) best = { place: p, score };
      }
    }
  }
  return best ? best.place : null;
}

// ---- dates ---------------------------------------------------------------------
const MONTHS_HI = ['जनवरी', 'फ़रवरी', 'मार्च', 'अप्रैल', 'मई', 'जून', 'जुलाई', 'अगस्त', 'सितंबर', 'अक्टूबर', 'नवंबर', 'दिसंबर'];
const MONTHS_EN = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

function fmtDate(iso, lang) {
  const [y, m, d] = (iso || '').split('-').map(Number);
  if (!y) return iso || '';
  return lang === 'hi' ? `${d} ${MONTHS_HI[m - 1]}` : `${d} ${MONTHS_EN[m - 1]}`;
}

function eventLine(e, lang) {
  const title = (lang === 'hi' && e.programme_hi) || e.programme_en || e.programme_hi || e.artists || '';
  const extra = [e.artists && e.artists !== title ? e.artists : '', e.venue].filter(Boolean).join(' · ');
  return `${e.is_highlight ? '⭐ ' : '• '}${e.time ? `${e.time} ` : ''}${title}${extra ? ` (${extra})` : ''}`;
}

// ---- building blocks ---------------------------------------------------------------
function menuBtn(lang) {
  return { id: 'core:menu', title: melaT(lang, '🏠 Menu', '🏠 मेनू') };
}

function categoriesPresent(snap) {
  const present = new Set((snap.places || []).map((p) => p.category));
  const ordered = MELA_CATEGORY_ORDER.filter((c) => present.has(c));
  const extra = Array.from(present).filter((c) => !MELA_CATEGORY_ORDER.includes(c)).sort();
  return ordered.concat(extra);
}

function catsWithCoords(snap) {
  return categoriesPresent(snap).filter((c) => (snap.places || []).some((p) => p.category === c && hasCoords(p)));
}

function isShifted(snap, cat) {
  const ids = new Set((snap.places || []).filter((p) => p.category === cat).map((p) => p.id));
  return (snap.duty || []).some((d) => ids.has(d.place_id) && d.shift_no != null);
}

function melaOut(messages, extra = {}) {
  return { messages, next_state: null, context: {}, done: true, log: { subtype: extra.subtype || null, resolved: true }, ...extra };
}

// ---- screens -------------------------------------------------------------------------
function melaMenu(req, snap, prefixText) {
  const lang = req.lang;
  const rows = [];
  const add = (id, en, hi, den, dhi) => rows.push({ id, title: melaT(lang, en, hi), description: melaT(lang, den || '', dhi || '') });
  if ((snap.events || []).length) add('mela:today', "Today's programme", 'आज का कार्यक्रम', 'Cultural programme and artists', 'सांस्कृतिक कार्यक्रम व कलाकार');
  add('mela:control', 'Control room', 'कंट्रोल रूम', 'Helpline and officers on duty now', 'हेल्पलाइन और अभी ड्यूटी पर अधिकारी');
  if (catsWithCoords(snap).length) add('mela:near', '📍 Near me', '📍 मेरे पास', 'Nearest police, health, vet camp', 'नज़दीकी थाना, अस्पताल, पशु शिविर');
  for (const c of categoriesPresent(snap)) add(`mela:cat:${c}`, `${catIcon(c)} ${catLabel(snap, c, 'en')}`, `${catIcon(c)} ${catLabel(snap, c, 'hi')}`);
  if ((snap.guidelines || []).length) add('mela:rules', "Do's & don'ts", 'क्या करें, क्या न करें');
  add('mela:ask', 'Ask a question', 'सवाल पूछें', 'History, timings, general info', 'इतिहास, समय, सामान्य जानकारी');
  // WhatsApp lists hold 10 rows: keep the first 9 and always keep "Ask".
  const ask = rows.pop();
  const shown = rows.slice(0, 9).concat([ask]);
  const body = [prefixText, melaT(lang,
    '🎪 *Sonpur Mela* – what would you like to know?\n(Type *english* / *हिंदी* to change language)',
    '🎪 *सोनपुर मेला* – आप क्या जानना चाहते हैं?\n(भाषा बदलने के लिए *english* / *हिंदी* लिखें)')].filter(Boolean).join('\n\n');
  return {
    messages: [{ type: 'list', body, button: melaT(lang, 'Choose', 'चुनें'),
      sections: [{ title: melaT(lang, 'Sonpur Mela', 'सोनपुर मेला'), rows: shown }] }],
    next_state: null, context: {}, done: false, log: { subtype: 'menu', resolved: true },
  };
}

function todayScreen(req, snap, dateIso) {
  const lang = req.lang;
  const today = dateIso || (req.now_ist || '').slice(0, 10);
  const events = (snap.events || []).filter((e) => e.date === today).sort((a, b) => (b.is_highlight - a.is_highlight) || String(a.time).localeCompare(String(b.time)));
  let body;
  if (events.length) {
    body = `${melaT(lang, `*Programme – ${fmtDate(today, 'en')}*`, `*कार्यक्रम – ${fmtDate(today, 'hi')}*`)}\n${events.map((e) => eventLine(e, lang)).join('\n')}`;
  } else {
    const next = (snap.events || []).filter((e) => e.date > today).sort((a, b) => a.date.localeCompare(b.date))[0];
    body = next
      ? melaT(lang, `No programme is listed for today.\nNext: *${fmtDate(next.date, 'en')}* – ${eventLine(next, lang).slice(2)}`,
        `आज के लिए कोई कार्यक्रम सूचीबद्ध नहीं है।\nअगला: *${fmtDate(next.date, 'hi')}* – ${eventLine(next, lang).slice(2)}`)
      : melaT(lang, 'The programme schedule will be announced soon.', 'कार्यक्रम की सूची जल्द जारी की जाएगी।');
  }
  return melaOut([{ type: 'buttons', body, buttons: [{ id: 'mela:schedule', title: melaT(lang, '📅 Full schedule', '📅 पूरा कार्यक्रम') }, menuBtn(lang)] }],
    { log: { subtype: 'today', resolved: events.length > 0 } });
}

function scheduleScreen(req, snap) {
  const lang = req.lang;
  const today = (req.now_ist || '').slice(0, 10);
  const upcoming = (snap.events || []).filter((e) => e.date >= today).sort((a, b) => a.date.localeCompare(b.date) || String(a.time).localeCompare(String(b.time)));
  if (!upcoming.length) {
    return melaOut([{ type: 'buttons', body: melaT(lang, 'The programme schedule will be announced soon.', 'कार्यक्रम की सूची जल्द जारी की जाएगी।'), buttons: [menuBtn(lang)] }],
      { log: { subtype: 'schedule', resolved: false } });
  }
  const lines = [];
  let last = null;
  for (const e of upcoming) {
    if (e.date !== last) { lines.push(`\n*${fmtDate(e.date, lang)}*`); last = e.date; }
    lines.push(eventLine(e, lang));
  }
  return melaOut([{ type: 'text', body: `${melaT(lang, '📅 *Sonpur Mela programme*', '📅 *सोनपुर मेला कार्यक्रम*')}${lines.join('\n')}` },
    { type: 'buttons', body: melaT(lang, 'Anything else?', 'और कुछ?'), buttons: [menuBtn(lang)] }], { log: { subtype: 'schedule', resolved: true } });
}

function helplineLines(snap, lang) {
  const s = snap.settings || {};
  const nums = [s.public_helpline_1, s.public_helpline_2].filter(Boolean);
  return nums.length ? melaT(lang, `☎️ *Mela control room:* ${nums.join(', ')}`, `☎️ *मेला कंट्रोल रूम:* ${nums.join(', ')}`) : '';
}

function controlScreen(req, snap, allShifts) {
  const lang = req.lang;
  const sh = currentShift(snap, req.now_ist);
  const desks = [];
  for (const row of snap.control || []) if (!desks.includes(row.desk)) desks.push(row.desk);
  const parts = [helplineLines(snap, lang), melaT(lang, '🚨 Emergency: 112 · Ambulance: 108', '🚨 आपातकाल: 112 · एम्बुलेंस: 108')].filter(Boolean);
  if (allShifts) {
    for (const s2 of shiftTable(snap)) {
      const lines = desks.map((desk) => {
        const people = onDuty((snap.control || []).filter((r) => r.desk === desk), s2.no).map(personLine).filter(Boolean);
        return people.length ? `• *${desk}*: ${people.join('; ')}` : null;
      }).filter(Boolean);
      if (lines.length) parts.push(`*${shiftLabel(s2, lang)}*\n${lines.join('\n')}`);
    }
  } else {
    const lines = desks.map((desk) => {
      const people = onDuty((snap.control || []).filter((r) => r.desk === desk), sh.no).map(personLine).filter(Boolean);
      return people.length ? `• *${desk}*: ${people.join('; ')}` : null;
    }).filter(Boolean);
    if (lines.length) parts.push(`${melaT(lang, `*Officers on duty now* (${shiftLabel(sh, 'en')})`, `*अभी ड्यूटी पर अधिकारी* (${shiftLabel(sh, 'hi')})`)}\n${lines.join('\n')}`);
  }
  const buttons = allShifts ? [menuBtn(lang)] : [{ id: 'mela:roster:control', title: melaT(lang, '🔁 All shifts', '🔁 सभी पालियाँ') }, menuBtn(lang)];
  return melaOut([{ type: 'text', body: `${melaT(lang, '🏛️ *Sonpur Mela control room*', '🏛️ *सोनपुर मेला कंट्रोल रूम*')}\n\n${parts.join('\n\n')}` },
    { type: 'buttons', body: melaT(lang, 'Anything else?', 'और कुछ?'), buttons }], { log: { subtype: allShifts ? 'control_roster' : 'control', resolved: true } });
}

function placeBlock(snap, p, lang, shiftNo, allShifts, distanceM) {
  const lines = [`*${placeName(p, lang)}*${distanceM != null ? ` – ${fmtDistance(distanceM, lang)}` : ''}`];
  const loc = placeLocation(p, lang);
  if (loc) lines.push(`📍 ${loc}`);
  if (p.hours) lines.push(`🕒 ${p.hours}`);
  const rows = (snap.duty || []).filter((d) => d.place_id === p.id);
  if (allShifts && rows.some((d) => d.shift_no != null)) {
    for (const sh of shiftTable(snap)) {
      const people = onDuty(rows, sh.no).map(personLine).filter(Boolean);
      if (people.length) lines.push(`${melaT(lang, `Shift ${sh.no}`, `पाली ${sh.no}`)} (${sh.start}–${sh.end}): ${people.join('; ')}`);
    }
  } else {
    for (const line of onDuty(rows, shiftNo).map(personLine).filter(Boolean)) lines.push(`👤 ${line}`);
  }
  if (hasCoords(p)) lines.push(`🧭 ${directionsUrl(p)}`);
  return lines.join('\n');
}

function categoryScreen(req, snap, cat, allShifts) {
  const lang = req.lang;
  const places = (snap.places || []).filter((p) => p.category === cat);
  if (!places.length) return melaMenu(req, snap, melaT(lang, 'This information is not available yet.', 'यह जानकारी अभी उपलब्ध नहीं है।'));
  const sh = currentShift(snap, req.now_ist);
  const shifted = isShifted(snap, cat);
  const head = `${catIcon(cat)} *${catLabel(snap, cat, lang)}*${shifted && !allShifts ? melaT(lang, ` – on duty now (${shiftLabel(sh, 'en')})`, ` – अभी ड्यूटी पर (${shiftLabel(sh, 'hi')})`) : ''}`;
  const blocks = places.map((p, i) => `${i + 1}. ${placeBlock(snap, p, lang, sh.no, allShifts)}`);
  const buttons = [];
  if (places.some(hasCoords)) buttons.push({ id: `mela:near:${cat}`, title: melaT(lang, '📍 Nearest', '📍 सबसे नज़दीक') });
  if (shifted && !allShifts) buttons.push({ id: `mela:roster:${cat}`, title: melaT(lang, '🔁 All shifts', '🔁 सभी पालियाँ') });
  buttons.push(menuBtn(lang));
  const helpline = helplineLines(snap, lang);
  return melaOut([{ type: 'text', body: `${head}\n\n${blocks.join('\n\n')}${helpline ? `\n\n${helpline}` : ''}` },
    { type: 'buttons', body: melaT(lang, 'Anything else?', 'और कुछ?'), buttons }], { log: { subtype: allShifts ? `${cat}_roster` : cat, resolved: true } });
}

function placeScreen(req, snap, p) {
  const lang = req.lang;
  const sh = currentShift(snap, req.now_ist);
  const msgs = [{ type: 'text', body: `${catIcon(p.category)} ${placeBlock(snap, p, lang, sh.no, false)}` }];
  if (hasCoords(p)) msgs.push({ type: 'location', lat: p.lat, lon: p.lon, name: placeName(p, lang), address: placeLocation(p, lang) });
  msgs.push({ type: 'buttons', body: melaT(lang, 'Anything else?', 'और कुछ?'), buttons: [{ id: `mela:cat:${p.category}`, title: melaT(lang, '📋 See all', '📋 सभी देखें') }, menuBtn(lang)] });
  return melaOut(msgs, { log: { subtype: 'place', resolved: true } });
}

function rulesScreen(req, snap) {
  const lang = req.lang;
  const g = (snap.guidelines || []).slice().sort((a, b) => a.sort - b.sort);
  const txt = (x) => (lang === 'hi' && x.text_hi) || x.text_en || x.text_hi;
  const sec = (kind, en, hi, icon) => {
    const items = g.filter((x) => x.kind === kind).map((x) => `${icon} ${txt(x)}`);
    return items.length ? `*${melaT(lang, en, hi)}*\n${items.join('\n')}` : null;
  };
  const body = [sec('emergency', 'In an emergency', 'आपात स्थिति में', '🚨'), sec('do', "Do's", 'क्या करें', '✅'), sec('dont', "Don'ts", 'क्या न करें', '❌')].filter(Boolean).join('\n\n');
  if (!body) return melaMenu(req, snap);
  return melaOut([{ type: 'buttons', body, buttons: [menuBtn(lang)] }], { log: { subtype: 'rules', resolved: true } });
}

// ---- near me -------------------------------------------------------------------------------
function nearChooser(req, snap) {
  const lang = req.lang;
  const cats = catsWithCoords(snap);
  if (!cats.length) return melaMenu(req, snap, melaT(lang, 'The location service will start soon.', 'लोकेशन सेवा जल्द शुरू होगी।'));
  return {
    messages: [{ type: 'list', body: melaT(lang, '📍 What are you looking for near you?', '📍 आप अपने पास क्या ढूँढ रहे हैं?'), button: melaT(lang, 'Choose', 'चुनें'),
      sections: [{ title: melaT(lang, 'Near me', 'मेरे पास'), rows: cats.slice(0, 10).map((c) => ({ id: `mela:near:${c}`, title: `${catIcon(c)} ${catLabel(snap, c, lang)}` })) }] }],
    next_state: null, context: {}, done: false, log: { subtype: 'near_menu', resolved: true },
  };
}

function askLocation(req, snap, cat) {
  const lang = req.lang;
  const withCoords = (snap.places || []).filter((p) => p.category === cat && hasCoords(p));
  if (!withCoords.length) {
    const r = categoryScreen(req, snap, cat, false);
    r.messages.unshift({ type: 'text', body: melaT(lang, `The location service for ${catLabel(snap, cat, 'en').toLowerCase()} starts soon. Here is the full list:`, `${catLabel(snap, cat, 'hi')} के लिए लोकेशन सेवा जल्द शुरू होगी। पूरी सूची:`) });
    return r;
  }
  return {
    messages: [{ type: 'location_request', body: melaT(lang,
      `Tap *Send location* to find the nearest ${catLabel(snap, cat, 'en', true)}.\nNo GPS? Type a nearby landmark instead (e.g. Kali Ghat).`,
      `नज़दीकी ${catLabel(snap, cat, 'hi', true)} जानने के लिए *Send location* दबाएँ।\nGPS नहीं है? पास की कोई जगह लिखें (जैसे काली घाट)।`) }],
    next_state: 'mela.await_location', context: { near_cat: cat }, done: false, log: { subtype: 'near_ask', resolved: true },
  };
}

function distanceBucket(m) {
  if (m < 250) return '<250m';
  if (m < 500) return '<500m';
  if (m < 1000) return '<1km';
  if (m < 2000) return '<2km';
  return '2km+';
}

function nearestScreen(req, snap, origin, cats, fromLandmark) {
  const lang = req.lang;
  const s = snap.settings || {};
  const center = s.mela_center_lat && s.mela_center_lon ? { lat: Number(s.mela_center_lat), lon: Number(s.mela_center_lon) } : null;
  const radiusM = (Number(s.mela_radius_km) || 5) * 1000;
  if (!fromLandmark && center && haversineM(origin.lat, origin.lon, center.lat, center.lon) > radiusM) {
    const cat = cats[0];
    const r = categoryScreen(req, snap, cat, false);
    r.messages.unshift({ type: 'text', body: melaT(lang, 'You seem to be outside the Mela area. Here is the full list:', 'आप मेला क्षेत्र से बाहर लगते हैं। पूरी सूची:') });
    r.log = { subtype: 'near_outside', resolved: true, detail: 'gps:outside' };
    return r;
  }
  const sh = currentShift(snap, req.now_ist);
  const msgs = [];
  const single = cats.length === 1;
  let nearestOverall = null;
  const sections = [];
  for (const cat of cats) {
    const ranked = (snap.places || []).filter((p) => p.category === cat && hasCoords(p))
      .map((p) => ({ p, d: haversineM(origin.lat, origin.lon, p.lat, p.lon) }))
      .sort((a, b) => a.d - b.d || a.p.sort - b.p.sort)
      .slice(0, single ? 3 : 1);
    if (!ranked.length) continue;
    if (!nearestOverall) nearestOverall = ranked[0];
    sections.push(`${catIcon(cat)} *${melaT(lang, `Nearest ${catLabel(snap, cat, 'en', true)}`, `नज़दीकी ${catLabel(snap, cat, 'hi', true)}`)}*\n` +
      ranked.map(({ p, d }, i) => `${single ? `${i + 1}. ` : ''}${placeBlock(snap, p, lang, sh.no, false, d)}`).join('\n\n'));
  }
  if (!sections.length) return melaMenu(req, snap, melaT(lang, 'The location service will start soon.', 'लोकेशन सेवा जल्द शुरू होगी।'));
  const note = melaT(lang, '_Distances are straight-line and approximate; tap 🧭 for walking directions._', '_दूरी सीधी रेखा में और अनुमानित है; पैदल रास्ते के लिए 🧭 दबाएँ।_');
  msgs.push({ type: 'text', body: `${sections.join('\n\n')}\n\n${note}` });
  msgs.push({ type: 'location', lat: nearestOverall.p.lat, lon: nearestOverall.p.lon, name: placeName(nearestOverall.p, lang), address: placeLocation(nearestOverall.p, lang) });
  const buttons = single ? [{ id: `mela:cat:${cats[0]}`, title: melaT(lang, '📋 See all', '📋 सभी देखें') }, menuBtn(lang)] : [menuBtn(lang)];
  msgs.push({ type: 'buttons', body: melaT(lang, 'Anything else?', 'और कुछ?'), buttons });
  // analytics: how far citizens are from help (bucketed; the location itself is never logged)
  const detail = `${fromLandmark ? 'landmark' : 'gps'}:${distanceBucket(nearestOverall.d)}`;
  return melaOut(msgs, { log: { subtype: single ? `near_${cats[0]}` : 'near_all', resolved: true, detail } });
}

// ---- admin: on-site coordinate capture -------------------------------------------------------
function adminCategories(req, snap) {
  const lang = req.lang;
  const cats = categoriesPresent(snap);
  const rows = cats.slice(0, 10).map((c) => {
    const all = snap.places.filter((p) => p.category === c);
    const done = all.filter(hasCoords).length;
    return { id: `mela:adm:cat:${c}:0`, title: `${catIcon(c)} ${catLabel(snap, c, 'en')}`.slice(0, 24), description: `${done}/${all.length} pinned` };
  });
  return {
    messages: [{ type: 'list', body: melaT(lang, '📌 Admin: pin site locations. Pick a category, then stand at the site entrance and share your location.', '📌 एडमिन: स्थान पिन करें। श्रेणी चुनें, फिर स्थल के प्रवेश पर खड़े होकर लोकेशन भेजें।'),
      button: 'Categories', sections: [{ title: 'Pin sites', rows }] }],
    next_state: null, context: {}, done: false, log: { subtype: 'adm_menu', resolved: true },
  };
}

function adminPlaces(req, snap, cat, page) {
  const all = snap.places.filter((p) => p.category === cat)
    .sort((a, b) => Number(hasCoords(a)) - Number(hasCoords(b)) || a.sort - b.sort); // unpinned first
  const per = 9;
  const slice = all.slice(page * per, page * per + per);
  const rows = slice.map((p) => ({ id: `mela:adm:place:${p.id}`, title: `${hasCoords(p) ? '✅' : '❌'} ${placeName(p, 'en')}`.slice(0, 24), description: `${p.id}${p.coord_source ? ` · ${p.coord_source}` : ''}` }));
  if (all.length > (page + 1) * per) rows.push({ id: `mela:adm:cat:${cat}:${page + 1}`, title: 'More ▸', description: '' });
  return {
    messages: [{ type: 'list', body: `${catLabel(snap, cat, 'en')}: choose the site you are standing at.`, button: 'Sites', sections: [{ title: 'Sites', rows }] }],
    next_state: null, context: {}, done: false, log: { subtype: 'adm_places', resolved: true },
  };
}

function adminAskLocation(req, snap, placeId) {
  const p = snap.places.find((x) => x.id === placeId);
  if (!p) return adminCategories(req, snap);
  return {
    messages: [{ type: 'location_request', body: `Stand at the entrance of *${placeName(p, 'en')}* (${p.id}) and tap *Send location*.` }],
    next_state: 'mela.adm_await_location', context: { adm_place: p.id }, done: false, log: { subtype: 'adm_ask', resolved: true },
  };
}

function adminConfirm(req, snap, ctx, loc) {
  const p = snap.places.find((x) => x.id === ctx.adm_place);
  if (!p) return adminCategories(req, snap);
  return {
    messages: [
      { type: 'location', lat: loc.lat, lon: loc.lon, name: `${placeName(p, 'en')} (${p.id})`, address: 'Captured point – check it on the map' },
      { type: 'buttons', body: `Save this point for *${placeName(p, 'en')}*?`, buttons: [{ id: 'mela:adm:save', title: '✅ Save' }, { id: `mela:adm:place:${p.id}`, title: '↻ Retry' }, menuBtn('en')] },
    ],
    next_state: 'mela.adm_confirm', context: { adm_place: p.id, adm_lat: loc.lat, adm_lon: loc.lon }, done: false, log: { subtype: 'adm_confirm', resolved: true },
  };
}

function adminSave(req, snap, ctx) {
  const p = snap.places.find((x) => x.id === ctx.adm_place);
  if (!p || typeof ctx.adm_lat !== 'number') return adminCategories(req, snap);
  return {
    messages: [{ type: 'buttons', body: `✅ Saved *${placeName(p, 'en')}* (${p.id}).`, buttons: [{ id: `mela:adm:cat:${p.category}:0`, title: 'Next site' }, { id: 'mela:adm:pin', title: 'Categories' }, menuBtn('en')] }],
    next_state: null, context: {}, done: false, log: { subtype: 'adm_saved', resolved: true },
    effects: [{ type: 'save_coords', place_id: p.id, lat: ctx.adm_lat, lon: ctx.adm_lon }],
  };
}

function adminStatus(req, snap) {
  const lines = categoriesPresent(snap).map((c) => {
    const all = snap.places.filter((p) => p.category === c);
    return `${catIcon(c)} ${catLabel(snap, c, 'en')}: ${all.filter(hasCoords).length}/${all.length} pinned`;
  });
  return melaOut([{ type: 'buttons', body: `📌 *Pin status*\n${lines.join('\n')}`, buttons: [{ id: 'mela:adm:pin', title: 'Pin sites' }, menuBtn('en')] }], { done: false, log: { subtype: 'adm_status', resolved: true } });
}

// ---- entry point -----------------------------------------------------------------------------------
function melaHandle(req, snap) {
  const s = snap || {};
  s.places = s.places || [];
  const input = req.input || {};
  const ctx = req.context || {};
  const id = input.id || '';
  const lang = req.lang === 'en' ? 'en' : 'hi';
  const r = { ...req, lang };

  // Admin tools (the router already rejects mela:adm:* from non-admins)
  if (id.startsWith('mela:adm:') && r.is_admin) {
    if (id === 'mela:adm:pin') return adminCategories(r, s);
    if (id === 'mela:adm:status') return adminStatus(r, s);
    if (id === 'mela:adm:save') return adminSave(r, s, ctx);
    let m = /^mela:adm:cat:([a-z_]+):(\d+)$/.exec(id);
    if (m) return adminPlaces(r, s, m[1], Number(m[2]));
    m = /^mela:adm:place:(.+)$/.exec(id);
    if (m) return adminAskLocation(r, s, m[1]);
  }
  if (r.is_admin && input.kind === 'text') {
    const t = normalise(input.text);
    if (t === 'pin' || t === 'pin sites') return adminCategories(r, s);
    if (t === 'pin status') return adminStatus(r, s);
  }
  if (req.state === 'mela.adm_await_location' && input.kind === 'location' && r.is_admin) return adminConfirm(r, s, ctx, input);

  // Button / list ids
  if (id === 'mela:open') return melaMenu(r, s);
  if (id === 'mela:today') return todayScreen(r, s);
  if (id === 'mela:schedule') return scheduleScreen(r, s);
  if (id === 'mela:control') return controlScreen(r, s, false);
  if (id === 'mela:roster:control') return controlScreen(r, s, true);
  if (id === 'mela:rules') return rulesScreen(r, s);
  if (id === 'mela:near') return nearChooser(r, s);
  if (id === 'mela:ask') {
    return { messages: [{ type: 'text', body: melaT(lang, '❓ Type your question about Sonpur Mela (history, timings, what to see…).', '❓ सोनपुर मेले के बारे में अपना सवाल लिखें (इतिहास, समय, क्या देखें…)।') }],
      next_state: 'mela.await_question', context: {}, done: false, log: { subtype: 'ask_prompt', resolved: true } };
  }
  let m = /^mela:cat:([a-z_]+)$/.exec(id);
  if (m) return categoryScreen(r, s, m[1], false);
  m = /^mela:roster:([a-z_]+)$/.exec(id);
  if (m) return categoryScreen(r, s, m[1], true);
  m = /^mela:near:([a-z_]+)$/.exec(id);
  if (m) return askLocation(r, s, m[1]);
  if (input.kind === 'open' || id) return melaMenu(r, s); // stale or unknown mela id

  // Location shared by a citizen
  if (input.kind === 'location') {
    const cats = ctx.near_cat ? [ctx.near_cat] : ['thana', 'health_centre'].filter((c) => catsWithCoords(s).includes(c));
    if (!cats.length) return melaMenu(r, s, melaT(lang, 'The location service will start soon.', 'लोकेशन सेवा जल्द शुरू होगी।'));
    return nearestScreen(r, s, { lat: input.lat, lon: input.lon }, cats, false);
  }

  // Free text
  const text = input.text || '';
  if (req.state === 'mela.await_location') {
    const landmark = matchPlace(s, text, true);
    if (landmark) return nearestScreen(r, s, landmark, [ctx.near_cat || 'thana'], true);
    if (!detectTopic(text).topic) {
      return { messages: [{ type: 'location_request', body: melaT(lang, "I couldn't find that place. Tap *Send location*, or type another landmark.", 'यह जगह नहीं मिली। *Send location* दबाएँ या कोई और जगह लिखें।') }],
        next_state: 'mela.await_location', context: ctx, done: false, log: { subtype: 'near_landmark_miss', resolved: false } };
    }
  }
  if (req.state === 'mela.await_question' && text) {
    return { messages: [], next_state: null, context: {}, done: true, log: { subtype: 'ask', resolved: true }, qa_request: { question: text } };
  }

  const intent = input.intent || {};
  const { near, topic: kwTopic } = detectTopic(text);
  const place = matchPlace(s, text);
  const topic = kwTopic || (intent.subtype && intent.subtype !== 'ask' ? intent.subtype : null) || (intent.slots && intent.slots.category) || null;
  const isCat = (t) => t && s.places.some((p) => p.category === t);
  if ((near || topic === 'near') && (isCat(topic) || !topic || topic === 'near')) {
    return isCat(topic) ? askLocation(r, s, topic) : nearChooser(r, s);
  }
  if (place && !isCat(topic)) return placeScreen(r, s, place);
  if (isCat(topic)) return categoryScreen(r, s, topic, false);
  // Lost person / theft etc. without a dedicated desk in the data: the control room
  // (helpline + officers on duty) is always the right answer, never a guess.
  if (topic === 'control' || topic === 'lost_found') return controlScreen(r, s, false);
  if (topic === 'today') return todayScreen(r, s);
  if (topic === 'schedule') return scheduleScreen(r, s);
  if (topic === 'rules' && (s.guidelines || []).length) return rulesScreen(r, s);
  if (place) return placeScreen(r, s, place);
  // Anything else about the Mela: answer from the approved general-info text.
  if (text) return { messages: [], next_state: null, context: {}, done: true, log: { subtype: 'ask', resolved: true }, qa_request: { question: text } };
  return melaMenu(r, s);
}

// ---- LLM Q&A over the approved Mela text ------------------------------------------------------------
function melaQaRequest(question, qaContext, snap, model) {
  const guide = (snap.guidelines || []).map((g) => `- [${g.kind}] ${g.text_en || g.text_hi}`).join('\n');
  return {
    model: model || 'claude-haiku-4-5',
    max_tokens: 600,
    temperature: 0,
    system: [
      'You answer questions from visitors to Sonpur Mela (Saran district, Bihar) on an official district WhatsApp helpline.',
      'Answer ONLY from the reference text below. If the answer is not in it, set answerable to false.',
      'Never write phone numbers, names of officials, prices or dates that are not in the reference text.',
      'Reply in the language of the question: Hindi (Devanagari) if the question is in Hindi or Hinglish, otherwise English.',
      'Keep the answer under 600 characters, plain and friendly. WhatsApp formatting (*bold*) is fine.',
      '',
      '<reference>', String(qaContext || '').slice(0, 20000), guide ? `\nVisitor guidelines:\n${guide}` : '', '</reference>',
    ].join('\n'),
    messages: [{ role: 'user', content: String(question).slice(0, 1000) }],
    output_config: { format: { type: 'json_schema', schema: {
      type: 'object',
      properties: { answerable: { type: 'boolean' }, answer: { type: 'string' } },
      required: ['answerable', 'answer'],
      additionalProperties: false,
    } } },
  };
}

function melaQaFinish(req, snap, resp) {
  const lang = req.lang === 'en' ? 'en' : 'hi';
  let data = null;
  if (resp && !resp.error && resp.stop_reason === 'end_turn') {
    try { data = JSON.parse(((resp.content || []).find((b) => b.type === 'text') || {}).text); } catch (e) { data = null; }
  }
  const tokens = resp && resp.usage ? (resp.usage.input_tokens || 0) + (resp.usage.output_tokens || 0) : 0;
  const buttons = [{ id: 'mela:ask', title: melaT(lang, '❓ Ask another', '❓ और सवाल') }, menuBtn(lang)];
  if (data && data.answerable && data.answer) {
    return { messages: [{ type: 'buttons', body: String(data.answer).slice(0, 1000), buttons }], next_state: null, context: {}, done: true,
      log: { subtype: 'ask', resolved: true, llm_tokens: tokens } };
  }
  const helpline = helplineLines(snap || {}, lang);
  const body = melaT(lang, "Sorry, I don't have that information. Please choose from the menu" + (helpline ? ` or call the control room.\n${helpline}` : '.'),
    'माफ़ कीजिए, यह जानकारी मेरे पास नहीं है। कृपया मेनू से चुनें' + (helpline ? ` या कंट्रोल रूम को फ़ोन करें।\n${helpline}` : '।'));
  return { messages: [{ type: 'buttons', body, buttons }], next_state: null, context: {}, done: false,
    log: { subtype: 'ask_unanswered', resolved: false, llm_tokens: tokens, unanswered_reason: resp && resp.error ? 'qa_error' : 'qa_no_answer' } };
}

if (typeof module !== 'undefined') {
  module.exports = { melaHandle, melaQaRequest, melaQaFinish, currentShift, haversineM, detectTopic, matchPlace, MELA_LABELS };
}
