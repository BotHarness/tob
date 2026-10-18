# Fixed Agent health check — T3 continuation

A Human organization member selects an active channel Agent and requests one fixed health check. The Agent's operator must separately allow that actual user ID in its local policy. Membership, ownership and channel credentials do not grant shell or filesystem authority. This increment checks only the executing Node process's platform, architecture and runtime version; it accepts no command, path or model instruction.

## Canonical request and result

`POST /api/organizations/:org/channels/:channel/work-requests` takes an Idempotency-Key and `{targetActorId, capability:"health-check", expiresAt}`. The server derives requester identity from the authenticated Human, binds the current membership ID, and atomically stores the typed message and request in Channel DO SQLite. The expiry must be within ten minutes; the phone chooses five. The operation produces a stable request ID. Identical retry returns the existing request even after expiry; it does not extend its execution deadline. Conflicting payloads fail.

An Agent polls its existing post-join channel history, then calls `POST /api/agent-channels/:channel/work-requests/:request/authorize`. Current Agent credential/issuer qualification, target, requesting Human admission and exact current organization membership are checked. The DO rechecks credential/expiry after provider waits. Removing and rejoining the requester does not reactivate an old request.

`POST .../:request/result` accepts a bounded typed result only from the target Agent. It uses a stable server-derived operation and the existing sequence/deduplication authority. A result may report completed work after request expiry; it does not authorize new work. Revoked Agent credentials cannot publish. The Agent remains responsible for truthful results: this is authenticated reporting, not remote hardware attestation.

Channel schema 4 adds message kind/payload and a request table. D1/Org remain 5/4. Reverting this code removes the work routes while retaining additive data. Existing text messages are not executable requests.

## Local execution owner

The reference module owns a private SQLite ledger and explicit local policy, bound to trusted instance configuration + channel + Agent identity. Configure requires the operator's confirmation and a list of allowed Human user IDs. An empty list denies everyone. Credentials and policy are private files; only paths and safe identifiers appear in CLI output.

The runner locks its state directory, checks discovery before every bearer, reads one bounded history page, rechecks policy after network authorization, and persists `started` before the fixed check. A completed result is persisted in an outbox before sending. Lost acknowledgements retry the identical result without rerunning. An interrupted `started` record becomes `needs-review`, with no automatic retry of execution. This narrow operation does not claim exactly-once arbitrary side effects or distributed execution leases.

## Public CLI and sample

```sh
node apps/cli/tob.mjs work request --server https://your-instance.example \
  --channel ch_... --agent ag_... --expires-at <ISO-8601> --operation <stable-operation>
node apps/cli/tob.mjs agent-health configure --credential-file /private/agent.json \
  --state-dir /private/agent-state --environment local-agent-a --allow-users user_... --confirm
node apps/cli/tob.mjs agent-health run --credential-file /private/agent.json \
  --state-dir /private/agent-state --after 0
```

The Human command uses the selected organization. `node examples/health-agent.mjs configure|run ...` uses the same module without a DSH installation or Human token. A runner returns nextCursor/hasMore; callers advance through pages. Replaying earlier pages is safe while retaining the ledger. Deleting the ledger is not an execution retry mechanism.

The phone saves target, deadline and operation in secure storage before transmission. Restart/retry preserves all three. Removing its local retry record or signing out does not cancel a request already accepted by the cloud. Results appear as readable channel messages; reload remains explicit in this HTTP slice.

## Acceptance status

Source checks cover permission/target/expiry, membership removal and rejoin, revocation during provider I/O, durable message/request idempotency, local allow-list, interruption before/after the check, lost result acknowledgement and private policy configuration. Mobile tests cover ordinary-member submission, secure persistence before sending, restart retry, mismatched response, and logout cleanup.

Real UAT CLI, native phone request/result, independent-process replay, screenshots/video and exact-head CI are still pending for this increment. This does not qualify WebSocket delivery, a DSH adapter, Agent-to-Agent forwarding, two isolated Hosts, Android/physical devices or Human QA. Keep T3 and the overall goal open; no Prod or merge.

## UAT continuation — 2026-10-18 JST

Service23db30d was deployed only to UAT (Worker version eb945fb5-c38b-44de-8f28-dc90f17112af), schema5/4/4. Service CI39087690616 passed. Initial deploy smoke failed without a classified cause; a subsequent read-only complete smoke passed. The first CLI attempt used an org B had not joined and correctly returned ORGANIZATION_ACCESS_DENIED; the final run used their existing shared organization without expanding membership.

Formal CLI created three requests/results: owner permitted, member rejected by the local policy, then a new member request permitted after explicit local grant. Identical request retry reused the same message; fresh-process history replay did not rerun completed work. Revoked Agent read/run was refused.

[Mobile Draft #2154](https://github.com/BotHarness/DeepSeekBot/pull/2154) Batch18 runtime8586130e5 passed actual member B request → independent Node process check → same-channel result. Clearing the local policy produced a second request's denial with count0; owner CLI read exactly four correlated messages. Six Dynamic Type/theme cases kept the request reachable; the maximum-size button was actually used. Coldrestart/refresh retained session and results. Own mobile logout/revoked latest refresh/local deletion and independent CLI preservation passed. Runtime CI39088289282 passed; evidence-only CI is tracked on the PR. Android, physical device, Human QA, new Hosted AuthKit, WebSocket, DSH forwarding/two Hosts remain separate gates. Test Agent revoked and shared Simulator window released; no Prod or merge.
