export const STATUSES = ['open', 'assigned', 'in_progress', 'resolved', 'closed'];

export const STATUS_LABEL = {
  open: 'Open', assigned: 'Assigned', in_progress: 'In progress', resolved: 'Resolved', closed: 'Closed',
};

export const STATUS_BADGE = {
  open: 'text-bg-danger', assigned: 'text-bg-warning', in_progress: 'text-bg-primary', resolved: 'text-bg-success', closed: 'text-bg-secondary',
};

export const ROLES = ['district_admin', 'dept_head', 'field_officer'];

export const ROLE_LABEL = {
  district_admin: 'District admin', dept_head: 'Department head', field_officer: 'Field officer',
};

export function fmtTime(d) {
  if (!d) return '';
  return new Intl.DateTimeFormat('en-IN', {
    timeZone: 'Asia/Kolkata', day: '2-digit', month: 'short', year: 'numeric', hour: '2-digit', minute: '2-digit', hour12: false,
  }).format(new Date(d));
}

// What citizens asked for, in plain words, from the (service_key, subtype) the
// bot logs on each message. Unknown codes fall back to the code itself, so a
// new bot screen still shows up (just less prettily) instead of disappearing.
const MELA_TOPIC = {
  menu: 'Mela menu', menu_more: 'Mela menu', today: "Today's programme", schedule: 'Full programme',
  control: 'Control room', control_roster: 'Control room', rules: "Do's & don'ts", place: 'A specific site',
  thana: 'Police stations', health_centre: 'Health centres', vet_camp: 'Veterinary camps', parking: 'Parking',
  ghat: 'Ghats', accommodation: 'Accommodation', toilet_water: 'Toilets & water', lost_found: 'Lost & found',
  help_desk: 'Help desks', ask: 'Free question', ask_prompt: 'Free question', ask_unanswered: 'Free question',
};
const COMPLAINT_TOPIC = {
  register: 'Complaint filed', registered: 'Complaint filed', mine: 'Status check', mine_empty: 'Status check',
  id_lookup: 'Status check', id_lookup_miss: 'Status check', geofence_reject: 'Complaint refused (outside area)',
};
const CORE_TOPIC = { feedback: 'Feedback 👍/👎', unsupported: 'Voice / video (not supported)', error: 'Errors', menu: 'Main menu' };

export function topicLabel(serviceKey, subtype) {
  const s = subtype || '';
  if (serviceKey === 'mela') {
    if (MELA_TOPIC[s]) return MELA_TOPIC[s];
    if (s.startsWith('near')) return 'Near me';
    if (s.startsWith('adm_')) return 'Admin: site pins';
    const cat = s.replace(/_roster$/, '');
    return MELA_TOPIC[cat] || `Mela: ${s}`;
  }
  if (serviceKey === 'complaint') return COMPLAINT_TOPIC[s] || 'Filing a complaint (steps)';
  if (CORE_TOPIC[s]) return CORE_TOPIC[s];
  if (serviceKey === '(core)' || !serviceKey) return 'Main menu';
  return `${serviceKey}: ${s}`;
}
