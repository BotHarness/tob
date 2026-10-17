// Operator-only UAT fixture authentication, never shipped to the product client.
export async function authenticateUser({ clientId, key, email, password }, request = fetch) {
  const call = async body => {
    const r = await request('https://api.workos.com/user_management/authenticate', {
      method: 'POST', redirect: 'error', signal: AbortSignal.timeout(15000),
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ client_id: clientId, client_secret: key, ...body }),
    });
    return { ok: r.ok, value: await r.json() };
  };
  let result = await call({ grant_type: 'password', email, password });
  if (!result.ok && result.value.code === 'organization_selection_required') {
    const orgs = result.value.organizations;
    if (!Array.isArray(orgs) || !orgs.length || !orgs.every(o => /^org_[A-Za-z0-9]+$/.test(o?.id)) || typeof result.value.pending_authentication_token !== 'string') throw Error('INVALID_SELECTION_CHALLENGE');
    // This isolated test actor has no interactive preference: pick a provider-listed membership.
    const organizationId = orgs.map(o => o.id).sort()[0];
    result = await call({ grant_type: 'urn:workos:oauth:grant-type:organization-selection', pending_authentication_token: result.value.pending_authentication_token, organization_id: organizationId });
  }
  if (!result.ok || typeof result.value.access_token !== 'string' || typeof result.value.refresh_token !== 'string') throw Error('SYNTHETIC_AUTHENTICATION_FAILED');
  return result.value;
}
