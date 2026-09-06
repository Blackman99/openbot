# API-02 public Bot contract

Implementation base: accepted BOT-06 merge `ae567149a1e741a830a244f751c379af50c9a523`. Ticket49's six acceptance criteria and PUBLIC-API-HANDOFF remain authoritative. API-01, BOT-03, BOT-04 and BOT-06 supply the existing token, configuration/version, direct-access and lifecycle operations. This ticket adds no migration and no second archive implementation.

## Transport and authority

External requests use `/v1` and API-01's exact `Bearer ob_…` credential syntax. Session cookies do not authorize public routes. Token credentials in query parameters remain rejected. Browser Origin is not an authorization requirement for Bearer requests. Responses are `Cache-Control: private, no-store` and `X-Content-Type-Options: nosniff`.

The token's persisted creator and bound workspace select the domain actor and workspace; clients cannot supply either identity. Every read requires `bots:read`; every mutation requires `bots:write`. Neither scope implies the other. Scopes intersect current workspace membership and direct Bot ACLs. Discovery-only viewers receive the same safe Bot summary as the Web UI; only direct users/editors/owners receive current configuration or version history. Editors/owners can update; only owners can archive.

Early API-01 authentication supplies routing context and the existing safe token-use audit. A server-created admission callback rechecks the same token ID/digest, current creator/workspace membership, revocation, expiry and required scope on the Bot operation's actual SQL connection immediately before COMMIT, after resource/provider/avatar waits and mandatory domain audit insertion. The domain operation already holds the workspace-first authority locks, which remain held through this final admission and commit. Time is sampled after those waits. A failed final check rolls back the entire domain transaction, including the new identity/version/pointer/ACL/reference and domain audit. Read operations also perform this final check before releasing their authorized result. No client input can supply or bypass the callback.

## Endpoints

| Method and path | Input | Success |
| --- | --- | --- |
| `GET /v1/bots` | `after=<UUID>&limit=<1..100>`; both optional, limit defaults to50 | `200 {bots,nextAfter}` |
| `POST /v1/bots` | Existing allowlisted Bot create configuration; 256KiB maximum | `201 {bot}` |
| `GET /v1/bots/:botId` | Canonicalized UUID | `200 {bot}` |
| `PATCH /v1/bots/:botId` | `{expectedCurrentVersionId,changes,rationale?}`; 256KiB maximum | `200 {version}` |
| `GET /v1/bots/:botId/versions` | Existing `before=<positive version number>&limit=<1..100>`; default50 | `200 {currentVersionId,versions,nextBefore}` |
| `GET /v1/bots/:botId/versions/:versionId` | Same-Bot version UUID | `200 {version}` |
| `POST /v1/bots/:botId/archive` | No body; 1KiB transport maximum | `200 {lifecycle}` |

Bot pagination orders canonical stable Bot UUIDs ascending. `after` is an exclusive key, and `nextAfter` is the last returned ID only when more visible results exist; otherwise null. Each page uses current token/workspace/Bot authority, excludes soft-deleted Bots like the default Web list, and includes archived Bots as inspectable identities. Unknown or duplicate query fields, invalid cursors and invalid limits are rejected. Historical version pagination retains BOT-03's descending version-number contract and current pointer.

Create, get and version DTOs are the existing safe Web domain projections. Create produces an active private Bot, version1 and the actor's owner ACL. Updates preserve omitted configuration and avatar references, reject arbitrary avatar/storage/ACL/lifecycle/author fields, and use BOT-03's current-version CAS. Stale updates return409 without replacing newer configuration; an effective ordinary no-op creates no version or domain audit. Explicit model selections require fresh actual-actor model admission. Archive calls BOT-06's existing owner operation, preserves all immutable configuration/history/avatar references and stable identity, blocks fresh use, and remains idempotent. No restore, copy, delete, ACL-management, group or task endpoints are added here.

## Errors and redaction

Errors are exact `{error:{code}}`, except `bot_model_unavailable`, which includes the existing allowlisted `reason`. Invalid/expired/revoked/orphan tokens return401 `invalid_api_token` plus `WWW-Authenticate: Bearer`; missing scope returns403 `insufficient_scope`. Current resource denial and missing/inaccessible Bot identity return403 `bot_forbidden`; missing same-Bot historical version returns404 `bot_version_not_found`; malformed input/body limits/media types return400/413/415 `invalid_bot_request`; stale CAS returns409 `bot_version_conflict`; unavailable retained avatar returns409 `bot_avatar_unavailable`; deleted-state archive returns409 `bot_lifecycle_conflict`; unavailable models return400 `bot_model_unavailable`; unexpected failures return503 `bot_unavailable`. No underlying database, provider or storage errors are returned.

Responses and audits never contain provider credentials, sensitive headers, private-memory content, internal encryption fields or storage keys. Public outputs use the same explicit DTO shapes as the existing UI, with ISO timestamps and canonical UUIDs. A failed or unreadable response after submission is an unknown mutation outcome; clients inspect current state before retrying.

## Acceptance and evidence

| Ticket49 criterion | Required evidence |
| --- | --- |
| AC1 scoped retrieval/pagination | Actual Fastify/domain tests for read-only tokens, bound workspace, discovery/direct ACL projections, stable pages and fresh admission |
| AC2 scoped create/update/archive visible in UI | Actual public API writes consumed by the existing strict Web clients and owner page/browser journey |
| AC3 UI changes round-trip | Existing UI/BFF configuration edit followed by public retrieval and version inspection, preserving every configuration field/avatar reference |
| AC4 stale update conflict | Actual Web/public competing writes return409 and retain the current pointer/configuration |
| AC5 redaction | Seeded provider key/header, private-memory and encryption sentinel scans of responses and new records/audits |
| AC6 OpenAPI3.1 | A committed OpenAPI3.1 document and schema validation of real success/error responses, pagination and permission cases |

Native PostgreSQL tests must cover final admission after blocking resource/audit waits, concurrent revocation, expiry during waits, and rollback of post-mutation guard failure. Their actual restricted-role CI run remains external; pg-mem assertions and discovered/skipped cases are not native transaction evidence. Root owns independent Standards/Spec review, browser-port leases, dedicated merge, publication and release evidence.
