# One-hop work forwarding

T4 begins with a bounded public protocol: an authenticated Agent A can forward a pending health-check request to Agent B in the same channel. This protocol increment does not yet complete the DSH Host/phone tracer bullet.

## Authority and persistence

`POST /api/agent-channels/:channel/work-requests/:request/forward` accepts only `{targetActorId}`. The caller must be the original target. Channel DO constructs the child from its canonical parent: original Human user and membership ID, channel, capability, creation time and expiry are unchanged. The child records `delegation: {parentRequestId, actorId, hops: 1}` and its visible author is Agent A. A child cannot forward again or return to A.

One unique parent column and a server-derived child ID allow only one child. The message and child row commit in the same synchronous SQLite transaction. Identical retries return that child; selecting another target conflicts. Acknowledgement recovery does not extend the deadline. Current issuer/requester checks still apply before reading back a retry.

Execution authorization now durably selects execution before returning to an Agent. Forwarding and execution cannot both win the same parent. Finished results cannot obtain a later execution authorization. A rejected result also closes the forwarding option. A forwarding parent cannot publish its own execution result. This is a protocol fence, not a claim that arbitrary local effects execute exactly once.

B must check the original Human's current admission and exact membership, B's current credential/owner, and the forwarding Agent/owner. The DO rechecks local credentials and expiry after external identity waits. B's operator must independently permit the original Human in B's local policy. A's ownership or local permissions do not grant B permission. A's eventual DSH forwarding tool also needs its own explicit local target policy; this increment does not install that tool.

The reference health runner accepts the typed child only when its visible Agent author matches its delegation. Ordinary messages remain non-executable. B's result cites the child request; the child points to the original parent. Existing mobile history renders the server's readable request/result text; a dedicated forwarding control is not added in this increment.

## Public CLI

```sh
node apps/cli/tob.mjs agent-channel forward \
  --credential-file /private/agent-a.json \
  --request wr_... --target ag_...
```

The credential is read from an owner-only file. Discovery must match trusted configuration before a bearer is sent. The CLI never accepts a replacement Human, capability, deadline or hop count and checks the returned Agent author/target/parent. Calling it is an explicit operator forwarding action; it is not an automatic unrestricted forwarding loop.

Configure and run B with the existing `agent-health configure|run` commands and B's original-Human allow-list. Preserve B's private ledger across restarts; replaying a completed child resends no work. Deleting the ledger is not a retry strategy.

## Migration and rollback

Channel schema 5 adds nullable unique `parent_request_id` and default-false `execution_authorized`. Existing work and text rows remain. D1/Org schemas stay 5/4.

After accepting forwarded work, do not downgrade to an older Worker that ignores these fields: it could authorize execution of a forwarded parent. Prefer a forward fix. An emergency downgrade requires stopping the affected Agents and quiescing work requests first; preserving SQLite columns alone is insufficient. This is an authorization/data-contract rollout boundary, even though the SQL migration is additive.

## Verification boundary

Local Worker tests exercise one-hop/author/expiry restrictions, canonical replay after DO eviction, execution-versus-forward races, conflicting concurrent targets, atomic rollback, original membership loss/rejoin and revocation during provider waits. Node tests exercise the public CLI/discovery boundary, visible-author parsing, original-Human local policy and local ledger replay.

Real UAT forwarding and independent-process execution are pending. DSH Messaging/Runtime integration, model-driven A, two isolated Hosts, automatic WebSocket delivery and the complete mobile-to-A-to-B scenario remain pending. Keep T4 open. No Prod or merge.
