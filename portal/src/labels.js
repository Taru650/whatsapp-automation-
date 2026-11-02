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
