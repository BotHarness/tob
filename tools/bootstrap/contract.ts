// Shared by the protected control-plane tool and real D1 runtime tests.
export const INITIALIZE_SQL = `INSERT INTO management_operation
(operation_id, actor_id, kind, payload_hash, target_id, state, updated_at)
SELECT 'instance.initialize', ?, 'instance.initialize', ?, ?, 'succeeded', ?
WHERE NOT EXISTS (SELECT 1 FROM management_operation WHERE operation_id = 'instance.initialize')`;
export interface Receipt { payload_hash: string; target_id: string; state: string; kind: string }
export function checkReceipt(receipt: Receipt | null, expectedHash: string, userId: string, status: string | null, policiesValid: boolean) {
  if (!receipt || receipt.kind !== 'instance.initialize' || receipt.payload_hash !== expectedHash || receipt.target_id !== userId || receipt.state !== 'succeeded' || status !== 'active' || !policiesValid) {
    throw new Error('BOOTSTRAP_CONFLICT_OR_INACTIVE');
  }
}
export function checkInvitee(
  invitation: { state: string; organization_id: string | null; accepted_user_id: string | null },
  user: { id: string; email: string; email_verified: boolean },
  expectedEmail: string,
  confirmedActiveUser: string,
) {
  if (invitation.state !== 'accepted' || invitation.organization_id !== null || invitation.accepted_user_id !== user.id || !user.id.startsWith('user_') || user.id !== confirmedActiveUser || user.email.toLowerCase() !== expectedEmail.toLowerCase() || user.email_verified !== true) throw new Error('INVITEE_NOT_ELIGIBLE');
  return user.id;
}
