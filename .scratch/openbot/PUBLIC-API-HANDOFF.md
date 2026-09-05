# Public API domain handoff

API-02 is implemented and its actual service gate is closed by Verify33960029570. API-03 remains future work; the shared authority and dependency decisions below still apply.

- API-02 archive consumes BOT-06 lifecycle behavior. API-03 default Lead consumes COL-06, and group concurrency consumes COL-13. The added prerequisites preserve all67 tickets and401 acceptance criteria and leave the graph acyclic. API-03 owns group archive because COL-01 explicitly excludes it.
- External routes use `/v1` Bearer authentication, distinct from `/api/v1` session/BFF routes. Reuse the existing API-01 token syntax and explicit scopes. A token's bound workspace is authoritative; a request parameter cannot select another workspace.
- Token scopes intersect the current creator's workspace membership and direct Bot or group permissions. Workspace/group administration does not grant Bot configuration rights. Use the same domain operations and safe projections as the Web UI.
- An early token identity snapshot does not provide final write admission after waiting for domain locks. Recheck current token validity and required scope within the transaction that admits the resource mutation, using the same workspace-first lock ordering as token revocation and membership removal.
- Public Bot updates keep current-version CAS, safe historical version projection and BOT-06 lifecycle semantics. Public group writes keep the same typed ledger, history grants, routing and concurrency policies; do not introduce parallel archive/member models.
- API-02 requires OpenAPI3.1 contract coverage. Keep pagination, permission errors and redacted output consistent across Web and external API tests. Neither public API may expose provider secrets, private memory or encryption internals.
