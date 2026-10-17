import { test } from 'node:test';
import assert from 'node:assert/strict';
import { publicInstance, parseInstance, connectionKey, MOBILE_REDIRECT_URI } from '../packages/contracts/instance.ts';
const input = { instanceId: 'tob-test-uat', environment: 'uat', server: 'https://test.example', clientId: 'client_test', issuer: 'https://api.workos.com/user_management/client_test', authkitDomain: 'test.authkit.app' };
test('mobile callback changes critical connection identity and must be the single registered development URI', () => {
  const before = publicInstance(input), after = publicInstance({ ...input, mobileRedirectUri: MOBILE_REDIRECT_URI });
  assert.notEqual(connectionKey(before), connectionKey(after));
  assert.deepEqual(parseInstance(after).auth.mobileRedirectUris, [MOBILE_REDIRECT_URI]);
  for (const mobileRedirectUris of [[MOBILE_REDIRECT_URI, MOBILE_REDIRECT_URI], ['ai.botharness.deepseekbot:/oauth2redirect'], ['https://evil.test/callback']]) {
    assert.throws(() => parseInstance({ ...after, auth: { ...after.auth, mobileRedirectUris } }), /INVALID_INSTANCE_CONFIG/);
  }
});
