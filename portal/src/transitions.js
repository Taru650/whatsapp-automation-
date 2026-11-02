// Every status change the portal may make, in one place. Resolving/closing
// arrives in M7 together with the mandatory closure evidence (the DB trigger
// in sql/30_grievance.sql refuses it without evidence anyway).

// Assigning (or re-assigning) is allowed until the complaint is resolved.
export function statusAfterAssign(status) {
  if (status === 'open') return 'assigned';
  if (status === 'assigned' || status === 'in_progress') return status;
  return null;
}

export function canStart(status) {
  return status === 'assigned';
}

export function canTransfer(status) {
  return status === 'open' || status === 'assigned' || status === 'in_progress';
}
