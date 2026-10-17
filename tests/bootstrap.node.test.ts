import { test } from 'node:test';
import assert from 'node:assert/strict';
import { checkInvitee } from '../tools/bootstrap/contract.ts';
const invitation = { state: 'accepted', organization_id: null, accepted_user_id: 'user_admin' };
const user = { id: 'user_admin', email: 'admin@example.test', email_verified: true };
test('only the actual accepted and verified target can become first administrator', () => {
  assert.equal(checkInvitee(invitation, user, 'admin@example.test', user.id), user.id);
  for (const state of ['pending', 'expired', 'revoked']) assert.throws(() => checkInvitee({ ...invitation, state }, user, user.email, user.id));
  assert.throws(() => checkInvitee({ ...invitation, accepted_user_id: 'user_other' }, user, user.email, user.id));
  assert.throws(() => checkInvitee({ ...invitation, organization_id: 'org_other' }, user, user.email, user.id));
  assert.throws(() => checkInvitee(invitation, { ...user, email_verified: false }, user.email, user.id));
  assert.throws(() => checkInvitee(invitation, { ...user, email: 'other@example.test' }, user.email, user.id));
  assert.throws(() => checkInvitee(invitation, user, user.email, 'user_not_checked'));
});
