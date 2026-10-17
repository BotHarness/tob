// Runtime verification harness, not the product CLI/session store.
// AuthKit owns the login UI. No server API key, browser callback or proxy is used.
import { privateProfile, jsonRequest } from './private-profile.mjs';
import { verifyHumanToken } from '../../apps/service/src/auth/workos.ts';
let phase = "inputs";
try {
  const profile = privateProfile(process.argv[2]);
  const mode = process.argv[3];
  if (!['login', 'me'].includes(mode)) throw new Error('USAGE');
  const target = profile.json('uat-target.json');
  if (!/^client_[A-Za-z0-9]+$/.test(target.WORKOS_CLIENT_ID) || target.WORKOS_ISSUER !== 'https://api.workos.com/') throw new Error('INVALID_TRUSTED_CONFIG');
  const server = new URL(target.PUBLIC_BASE_URL);
  if (server.protocol !== 'https:' || server.origin !== target.PUBLIC_BASE_URL) throw new Error('INVALID_SERVER');
  const authHost = new URL('https://' + target.WORKOS_AUTH_DOMAIN);
  if (!authHost.hostname.endsWith('.authkit.app') || authHost.pathname !== '/' || authHost.username || authHost.password) throw new Error('INVALID_AUTH_HOST');
  const form = body => ({ method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' }, body: new URLSearchParams(body), redirect: 'error', signal: AbortSignal.timeout(10000) });
  phase = 'target-health';
  const health = await jsonRequest(new URL('/healthz', server));
  if (health.environment !== 'uat' || health.instanceId !== target.INSTANCE_ID) throw new Error('INSTANCE_MISMATCH');
  let session;
  if (mode === 'login') {
    profile.requireAbsent('uat-login-session.json');
    phase = 'device-authorization';
    const device = await jsonRequest('https://api.workos.com/user_management/authorize/device', form({ client_id: target.WORKOS_CLIENT_ID }));
    if (new URL(device.verification_uri).origin !== authHost.origin || typeof device.device_code !== 'string' || !Number.isFinite(device.interval) || !Number.isFinite(device.expires_in)) throw new Error('INVALID_DEVICE_RESPONSE');
    console.log(JSON.stringify({ event: 'confirm_login', verificationUri: device.verification_uri, userCode: device.user_code }));
    const deadline = Date.now() + Math.min(device.expires_in, 900) * 1000;
    let delay = Math.max(device.interval, 5) * 1000;
    while (Date.now() < deadline) {
      await new Promise(resolve => setTimeout(resolve, delay));
      let response;
      try { response = await fetch('https://api.workos.com/user_management/authenticate', form({ client_id: target.WORKOS_CLIENT_ID, device_code: device.device_code, grant_type: 'urn:ietf:params:oauth:grant-type:device_code' })); }
      catch { continue; }
      const value = await response.json();
      if (response.ok) { session = value; break; }
      if (value.error === 'slow_down') { delay += 5000; continue; }
      if (value.error !== 'authorization_pending') throw new Error('DEVICE_AUTH_FAILED');
    }
    if (!session) throw new Error('DEVICE_AUTH_TIMEOUT');
    phase = 'verify-and-save-session';
    await verifyHumanToken('Bearer ' + session.access_token, target.WORKOS_CLIENT_ID, target.WORKOS_ISSUER);
    // New login never silently overwrites a previous session.
    profile.createJson('uat-login-session.json', { clientId: target.WORKOS_CLIENT_ID, server: server.origin, accessToken: session.access_token, refreshToken: session.refresh_token });
  } else {
    const saved = profile.json('uat-login-session.json');
    if (saved.clientId !== target.WORKOS_CLIENT_ID || saved.server !== server.origin) throw new Error('SESSION_TARGET_MISMATCH');
    session = { access_token: saved.accessToken };
  }
  phase = 'authenticated-probe';
  const identity = await verifyHumanToken('Bearer ' + session.access_token, target.WORKOS_CLIENT_ID, target.WORKOS_ISSUER);
  const r = await fetch(new URL('/api/me', server), { headers: { Authorization: 'Bearer ' + session.access_token }, redirect: 'error', signal: AbortSignal.timeout(10000) });
  const body = await r.json();
  console.log(JSON.stringify({ event: 'uat_identity_probe', status: r.status, identityMatches: body.userId === identity.userId, instanceMatches: body.instanceId === target.INSTANCE_ID, role: body.instanceRole, errorCode: body.error?.code }));
} catch { console.error(JSON.stringify({ event: 'uat_login_check_failed', phase })); process.exitCode = 1; }
