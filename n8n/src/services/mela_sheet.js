// Sonpur Mela sheet -> validated, normalised data (used by the sync workflow).
// Input: { tabName: [[header...], [row...], ...] } exactly as the Google Sheets
// API (values:batchGet, FORMATTED_VALUE) returns it.
// Output: { data, errors, warnings, counts }. Any error rejects the whole sync
// (the last good data stays live); warnings go to the daily digest.

const MELA_TABS = {
  places: ['id', 'category', 'name_en', 'name_hi', 'location_en', 'location_hi', 'lat', 'lon', 'hours',
    's1_name', 's1_phone', 's2_name', 's2_phone', 's3_name', 's3_phone', 'allday_name', 'allday_phone', 'phone_2',
    'notes', 'active', 'verified', 'updated_by'],
  control_room: ['desk', 's1_name', 's1_designation', 's1_phone', 's2_name', 's2_designation', 's2_phone',
    's3_name', 's3_designation', 's3_phone', 'allday_name', 'allday_designation', 'allday_phone', 'phone_2',
    'active', 'verified', 'updated_by'],
  events: ['id', 'date', 'time', 'programme_en', 'programme_hi', 'artists', 'department', 'venue', 'is_highlight',
    'active', 'verified', 'updated_by'],
  guidelines: ['id', 'kind', 'text_en', 'text_hi', 'sort', 'active', 'verified', 'updated_by'],
  settings: ['key', 'value'],
};
const REQUIRED_TABS = ['places', 'control_room', 'events', 'settings'];
const CATEGORY_RE = /^[a-z][a-z_]{1,30}$/;
const KNOWN_DESKS = ['Magistrate', 'Police', 'Sanitation & Water', 'Electricity', 'Health', 'Other'];
const GUIDELINE_KINDS = ['do', 'dont', 'emergency'];
// Legacy Kruti Dev text looks like "¼u[kk'k½" (it should read "नखास").
const KRUTI_DEV = /[¼½¾]|[a-z]\[[a-z]|\][a-z]/i;
const DEVANAGARI = /[ऀ-ॿ]/;

function cell(v) {
  return v == null ? '' : String(v).trim();
}

function asBool(v, dflt) {
  const s = cell(v).toLowerCase();
  if (s === '') return dflt;
  return ['true', 'yes', 'y', '1', '✓', 'हाँ', 'हां'].includes(s);
}

// Returns { value: display string, digits, error, warning }
function normPhone(raw) {
  const s = cell(raw);
  if (!s) return { value: '', digits: '' };
  const digits = s.replace(/\D/g, '');
  let d = digits;
  if (/^91[6-9]\d{9}$/.test(d)) d = d.slice(2);
  if (/^[6-9]\d{9}$/.test(d)) {
    const warning = /^(6152|6158|6151|6153|6154|6156|6157|6159)/.test(d)
      ? `"${s}" looks like a Saran landline missing its leading 0 (e.g. 0${d.slice(0, 4)}-${d.slice(4)})`
      : null;
    return { value: d, digits: d, warning };
  }
  if (/^0\d{9,11}$/.test(d)) return { value: s.replace(/\s+/g, ''), digits: d };
  if (/^(100|101|102|108|112|1091|1098|1930|1033|1800\d{6,7})$/.test(d)) return { value: d, digits: d };
  return { value: s, digits: d, error: `invalid phone "${s}" (need a 10-digit mobile starting 6-9, or a landline with STD code and leading 0)` };
}

function normDate(raw) {
  const s = cell(raw);
  let m = s.match(/^(\d{4})-(\d{1,2})-(\d{1,2})$/);
  if (m) return iso(+m[1], +m[2], +m[3]);
  m = s.match(/^(\d{1,2})[/.-](\d{1,2})[/.-](\d{4})$/); // DD/MM/YYYY (Indian order)
  if (m) return iso(+m[3], +m[2], +m[1]);
  return null;
}

function iso(y, mo, d) {
  const dt = new Date(Date.UTC(y, mo - 1, d));
  if (dt.getUTCFullYear() !== y || dt.getUTCMonth() !== mo - 1 || dt.getUTCDate() !== d) return null;
  return `${y}-${String(mo).padStart(2, '0')}-${String(d).padStart(2, '0')}`;
}

function normTime(raw) {
  const s = cell(raw).toLowerCase().replace(/\s+/g, '');
  if (!s) return '';
  let m = s.match(/^(\d{1,2}):(\d{2})$/);
  if (m && +m[1] < 24 && +m[2] < 60) return `${m[1].padStart(2, '0')}:${m[2]}`;
  m = s.match(/^(\d{1,2})(?::(\d{2}))?(am|pm)$/);
  if (m && +m[1] >= 1 && +m[1] <= 12) {
    const h = (+m[1] % 12) + (m[3] === 'pm' ? 12 : 0);
    return `${String(h).padStart(2, '0')}:${m[2] || '00'}`;
  }
  return null;
}

function rowsOf(values) {
  const [header = [], ...body] = values || [];
  const cols = header.map((h) => cell(h).toLowerCase());
  const rows = [];
  body.forEach((r, i) => {
    if (!r || r.every((v) => cell(v) === '')) return;
    const o = { __row: i + 2 };
    cols.forEach((c, j) => { if (c) o[c] = cell(r[j]); });
    rows.push(o);
  });
  return { cols, rows };
}

function validateMelaSheet(tabs, opts = {}) {
  const requireVerified = !!opts.requireVerified;
  const today = opts.today || null; // 'YYYY-MM-DD' (IST)
  const errors = [];
  const warnings = [];
  const err = (tab, row, msg) => errors.push({ tab, row, msg });
  const warn = (tab, row, msg) => warnings.push({ tab, row, msg });
  const data = { places: [], duty: [], control: [], events: [], guidelines: [], settings: {} };
  const phoneOwners = new Map(); // digits -> Set(person|place)
  let skippedUnverified = 0;

  const textCheck = (tab, r, col) => {
    const v = r[col] || '';
    if (v && KRUTI_DEV.test(v)) err(tab, r.__row, `${col}: "${v}" looks like legacy Kruti Dev text; retype it in Unicode`);
    if (col.endsWith('_hi') && v && !DEVANAGARI.test(v)) warn(tab, r.__row, `${col}: "${v}" has no Devanagari text`);
  };
  const phone = (tab, r, col, owner) => {
    const p = normPhone(r[col]);
    if (p.error) err(tab, r.__row, `${col}: ${p.error}`);
    if (p.warning) warn(tab, r.__row, `${col}: ${p.warning}`);
    if (p.digits && !p.error) {
      const set = phoneOwners.get(p.digits) || new Set();
      set.add(owner);
      phoneOwners.set(p.digits, set);
    }
    return p.error ? null : p.value;
  };
  const include = (tab, r) => {
    if (!asBool(r.active, true)) return false;
    if (requireVerified && !asBool(r.verified, false)) { skippedUnverified++; return false; }
    return true;
  };

  for (const t of REQUIRED_TABS) {
    if (!tabs || !tabs[t]) err(t, 1, `tab "${t}" is missing`);
  }
  for (const [t, expected] of Object.entries(MELA_TABS)) {
    if (!tabs || !tabs[t]) continue;
    const { cols } = rowsOf(tabs[t]);
    const missing = expected.filter((c) => !cols.includes(c));
    if (missing.length) err(t, 1, `missing column(s): ${missing.join(', ')}`);
  }
  if (errors.length) return { data: null, errors, warnings, counts: {} };

  // settings
  for (const r of rowsOf(tabs.settings).rows) {
    if (r.key) data.settings[r.key] = r.value || '';
  }
  for (const k of ['shift1_start', 'shift2_start', 'shift3_start']) {
    const v = normTime(data.settings[k] || '');
    if (!v) err('settings', 1, `${k} must be a time like 06:00`);
    else data.settings[k] = v;
  }
  for (const k of ['public_helpline_1', 'public_helpline_2']) {
    if (data.settings[k]) {
      const p = normPhone(data.settings[k]);
      if (p.error) err('settings', 1, `${k}: ${p.error}`);
      else data.settings[k] = p.value;
    }
  }
  if (!data.settings.public_helpline_1) warn('settings', 1, 'public_helpline_1 is empty: citizens have no single number to call');
  for (const k of ['mela_center_lat', 'mela_center_lon', 'mela_radius_km']) {
    if (data.settings[k] && Number.isNaN(Number(data.settings[k]))) err('settings', 1, `${k} must be a number`);
  }

  // places (+ duty unpivoted from shift columns)
  const ids = new Set();
  for (const r of rowsOf(tabs.places).rows) {
    if (!r.id) { err('places', r.__row, 'id is empty'); continue; }
    if (ids.has(r.id)) err('places', r.__row, `duplicate id "${r.id}"`);
    ids.add(r.id);
    if (!include('places', r)) continue;
    const category = (r.category || '').toLowerCase();
    if (!CATEGORY_RE.test(category)) err('places', r.__row, `category "${r.category}" must be a lowercase word like thana`);
    if (!r.name_en && !r.name_hi) err('places', r.__row, 'name_en or name_hi is required');
    ['name_en', 'name_hi', 'location_en', 'location_hi', 'notes'].forEach((c) => textCheck('places', r, c));
    let lat = null;
    let lon = null;
    if (r.lat || r.lon) {
      lat = Number(r.lat);
      lon = Number(r.lon);
      if (!(lat >= 6 && lat <= 37 && lon >= 68 && lon <= 98)) {
        err('places', r.__row, `lat/lon "${r.lat}, ${r.lon}" is not a location in India (lat 25.x, lon 85.x for Sonpur; check they are not swapped)`);
        lat = lon = null;
      }
    }
    data.places.push({ id: r.id, category, name_en: r.name_en, name_hi: r.name_hi, location_en: r.location_en,
      location_hi: r.location_hi, lat, lon, hours: r.hours, notes: r.notes, sort: data.places.length });
    const extra = phone('places', r, 'phone_2', `place:${r.id}`);
    for (const [shift, pfx] of [[1, 's1'], [2, 's2'], [3, 's3'], [null, 'allday']]) {
      const name = r[`${pfx}_name`];
      const ph = phone('places', r, `${pfx}_phone`, name || `place:${r.id}`);
      textCheck('places', r, `${pfx}_name`);
      if (!name && !ph) continue;
      if (ph === '' && name) warn('places', r.__row, `${pfx}_name "${name}" has no phone`);
      const phones = [ph, shift == null || !r.allday_name ? extra : ''].filter(Boolean);
      data.duty.push({ place_id: r.id, shift_no: shift, person_name: name || '', phones: Array.from(new Set(phones)) });
    }
    if (extra && !data.duty.some((d) => d.place_id === r.id)) {
      data.duty.push({ place_id: r.id, shift_no: null, person_name: '', phones: [extra] });
    }
  }

  // control room desks
  for (const r of rowsOf(tabs.control_room).rows) {
    if (!include('control_room', r)) continue;
    if (!r.desk) { err('control_room', r.__row, 'desk is empty'); continue; }
    if (!KNOWN_DESKS.includes(r.desk)) warn('control_room', r.__row, `desk "${r.desk}" is not one of ${KNOWN_DESKS.join(', ')}`);
    const extra = phone('control_room', r, 'phone_2', `desk:${r.desk}`);
    let any = false;
    for (const [shift, pfx] of [[1, 's1'], [2, 's2'], [3, 's3'], [null, 'allday']]) {
      const name = r[`${pfx}_name`];
      const ph = phone('control_room', r, `${pfx}_phone`, name || `desk:${r.desk}`);
      textCheck('control_room', r, `${pfx}_name`);
      if (!name && !ph) continue;
      any = true;
      data.control.push({ desk: r.desk, sort: data.control.length, shift_no: shift, person_name: name || '',
        designation: r[`${pfx}_designation`] || '', phones: Array.from(new Set([ph, shift == null ? extra : ''].filter(Boolean))) });
    }
    if (!any) warn('control_room', r.__row, `desk "${r.desk}" has nobody on duty`);
  }

  // events
  const eventIds = new Set();
  for (const r of rowsOf(tabs.events).rows) {
    if (!include('events', r)) continue;
    const id = r.id || `E${r.__row}`;
    if (eventIds.has(id)) err('events', r.__row, `duplicate id "${id}"`);
    eventIds.add(id);
    const date = normDate(r.date);
    if (!date) err('events', r.__row, `date "${r.date}" must look like 2026-11-24 or 24/11/2026`);
    const time = normTime(r.time);
    if (time === null) err('events', r.__row, `time "${r.time}" must look like 18:30`);
    if (!r.programme_en && !r.programme_hi && !r.artists) err('events', r.__row, 'programme or artists is required');
    ['programme_en', 'programme_hi', 'artists', 'venue'].forEach((c) => textCheck('events', r, c));
    data.events.push({ id, date, time: time || '', programme_en: r.programme_en, programme_hi: r.programme_hi,
      artists: r.artists, department: r.department, venue: r.venue, is_highlight: asBool(r.is_highlight, false) });
  }
  if (today && !data.events.some((e) => e.date && e.date >= today && e.date <= addDays(today, 30))) {
    warn('events', 1, 'no programme dated in the next 30 days (is the new schedule entered?)');
  }

  // guidelines (optional tab)
  if (tabs.guidelines) {
    for (const r of rowsOf(tabs.guidelines).rows) {
      if (!include('guidelines', r)) continue;
      if (!GUIDELINE_KINDS.includes((r.kind || '').toLowerCase())) err('guidelines', r.__row, `kind must be one of ${GUIDELINE_KINDS.join(', ')}`);
      if (!r.text_en && !r.text_hi) err('guidelines', r.__row, 'text_en or text_hi is required');
      ['text_en', 'text_hi'].forEach((c) => textCheck('guidelines', r, c));
      data.guidelines.push({ id: r.id || `G${r.__row}`, kind: (r.kind || '').toLowerCase(), text_en: r.text_en,
        text_hi: r.text_hi, sort: Number(r.sort) || data.guidelines.length });
    }
  }

  // test / placeholder data must never reach citizens in production
  if (opts.rejectPlaceholders) {
    const blob = JSON.stringify(data);
    if (/DUMMY-TEST-DATA|PLACEHOLDER|\bTODO\b/i.test(blob)) err('*', 0, 'contains DUMMY-TEST-DATA / PLACEHOLDER / TODO text');
  }

  for (const [digits, owners] of phoneOwners) {
    const people = Array.from(owners).filter((o) => !o.startsWith('place:') && !o.startsWith('desk:'));
    if (new Set(people).size > 1) warn('*', 0, `phone ${digits} is listed for different people: ${people.join(' / ')}`);
  }
  if (skippedUnverified) warn('*', 0, `${skippedUnverified} row(s) not marked verified were left out`);

  const counts = { places: data.places.length, duty: data.duty.length, control: data.control.length,
    events: data.events.length, guidelines: data.guidelines.length };
  return { data: errors.length ? null : data, errors, warnings, counts };
}

function addDays(isoDate, n) {
  const d = new Date(`${isoDate}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + n);
  return d.toISOString().slice(0, 10);
}

if (typeof module !== 'undefined') {
  module.exports = { validateMelaSheet, normPhone, normDate, normTime, MELA_TABS, KRUTI_DEV };
}
