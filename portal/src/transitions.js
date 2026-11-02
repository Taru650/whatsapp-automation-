// Every status change the portal may make, in one place. The officer closes
// directly with proof (no separate "resolved" review step); 'closed' is final.

export function canClose(status) {
  return status === 'assigned' || status === 'in_progress';
}

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
