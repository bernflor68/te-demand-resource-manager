// Status workflow & transition rules (section 9 of the specification).
// Actor tokens: manager = dispatch_manager|admin, owner = requestor of the request,
// assignee = technician whose resource is assigned to the request.
export const STATUSES = ['Submitted', 'Triage', 'Pending Approval', 'Approved', 'Scheduled', 'In Progress',
  'On Hold', 'Completed', 'Closed', 'Rejected', 'Cancelled'];
export const OPEN_STATUSES = ['Submitted', 'Triage', 'Pending Approval', 'Approved', 'Scheduled', 'In Progress', 'On Hold'];
export const PRIORITIES = ['Low', 'Medium', 'High', 'Critical'];
export const SAFETY = ['None', 'Low', 'High'];
export const ROLES = ['requestor', 'technician', 'dispatch_manager', 'admin'];

const M = ['manager'];
export const TRANSITIONS = {
  'Submitted': [
    { to: 'Triage', label: 'Start triage', who: M },
    { to: 'Cancelled', label: 'Cancel', who: ['manager', 'owner'], comment: true }],
  'Triage': [
    { to: 'Pending Approval', label: 'Submit for approval', who: M, needsTeam: true },
    { to: 'On Hold', label: 'Put on hold', who: M, comment: true },
    { to: 'Rejected', label: 'Reject', who: M, comment: true },
    { to: 'Cancelled', label: 'Cancel', who: ['manager', 'owner'], comment: true }],
  'Pending Approval': [
    { to: 'Approved', label: 'Approve', who: M },
    { to: 'Rejected', label: 'Reject', who: M, comment: true },
    { to: 'Triage', label: 'Return to triage', who: M, comment: true }],
  'Approved': [
    { to: 'On Hold', label: 'Put on hold', who: M, comment: true },
    { to: 'Cancelled', label: 'Cancel', who: M, comment: true }],
  'Scheduled': [
    { to: 'In Progress', label: 'Start work', who: ['manager', 'assignee'] },
    { to: 'On Hold', label: 'Put on hold', who: M, comment: true },
    { to: 'Cancelled', label: 'Cancel', who: M, comment: true }],
  'In Progress': [
    { to: 'Completed', label: 'Mark completed', who: ['manager', 'assignee'] },
    { to: 'On Hold', label: 'Put on hold', who: M, comment: true }],
  'On Hold': [
    { to: '@resume', label: 'Resume', who: M },
    { to: 'Cancelled', label: 'Cancel', who: M, comment: true }],
  'Completed': [
    { to: 'Closed', label: 'Close', who: ['manager', 'owner'] },
    { to: 'In Progress', label: 'Reopen work', who: M, comment: true }],
  'Rejected': [
    { to: 'Triage', label: 'Reopen to triage', who: M, comment: true },
    { to: 'Closed', label: 'Close', who: ['manager', 'owner'] }],
  'Closed': [],
  'Cancelled': [],
};

export const isManager = (u) => u.role === 'dispatch_manager' || u.role === 'admin';

export function allowedTransitions(user, request, isAssignee) {
  return (TRANSITIONS[request.status] || []).filter((t) => t.who.some((w) =>
    (w === 'manager' && isManager(user)) ||
    (w === 'owner' && request.requestor_id === user.id) ||
    (w === 'assignee' && isAssignee)));
}
