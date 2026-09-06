# Bot identity and permission implementation contract

This records the recommended defaults selected for the approved BOT-01 and BOT-04 tickets. It is a design handoff; those tickets remain blocked until their prerequisites are integrated. The ticket acceptance criteria remain authoritative.

## Identity and versions

- A Bot has a stable workspace-scoped ID, an immutable sequence of BotVersions, a current-version pointer, and an independent BotAcl. The persona field `roleDescription` is distinct from the permission field `accessRole`.
- Creation atomically inserts the Bot, version 1, current pointer, sole creator-owner ACL and `bot.created` audit. An initial version records its author, creation time and rationale `Created`.
- Store identity, instructions, model binding and execution limits in the version configuration. A composite reference ensures the current version belongs to the same Bot. Database privileges must prevent historical configuration updates.
- BOT-01 creates private Bots. BOT-04 later controls visibility and ACL changes. Listing and detail queries apply workspace and Bot visibility before returning records; guessed cross-workspace IDs reveal no information.
- Field bounds: name 1–100 characters; role description 1–200; optional description at most 2,000; nonblank instructions at most 32,000. Preserve instruction formatting rather than trimming meaningful content.

## Model binding

- Binding is `{ scope, connectionId, modelId }`. Creation requires a currently accessible, enabled model with verified effective Basic capability. Legacy unknown evidence requires an explicit re-probe; creation does not silently perform network requests.
- Basic requires text and streaming. Collaboration additionally requires reliable tool calling or structured output. List/detail views label Basic-only Bots as chat-only and unsuitable for reliable delegation.
- The selected model ID is immutable within a version. Changing the connection's model requires a new Bot version/rebinding; rotating credentials alone does not change that identity.
- Use the narrow provider admission operation with the existing SQL connection, current actor/workspace and expected model ID. Its final authority and capability checks occur inside the Bot mutation transaction after acquiring the documented provider scope lock. A resolution preview is a snapshot, not authorization for a later mutation.
- Bot ACLs never confer provider-connection use. Execution and copying must check the acting user's current provider rights. Workspace connections support shared use without revealing their credentials.
- List/detail return a fresh viewer-specific `bindingStatus`, separate from immutable version configuration: `ready` with current `chatOnly`, or `unavailable` with a safe reason (`disabled`, `binding-changed`, `capability-unavailable`, or `not-accessible`). Check Bot access first, then reuse provider admission in the existing transaction with the viewer's authority. Deduplicate identical binding checks per list. Collapse missing/inaccessible connections; propagate unexpected database failures. Do not substitute models/fallbacks or use creation-time capability badges as current claims. Discovery-only responses omit binding IDs and configuration. These read-time results never authorize a future execution.

## Execution defaults

| Field | Default | Allowed range |
| --- | ---: | ---: |
| `maxTotalTokens` | 32,768 | 1–1,000,000 |
| `maxDurationSeconds` | 300 | 1–3,600 |
| `maxTurns` | 8 | 1–100 |
| `maxDelegationDepth` | 2 | 0–8 |

The root Task has delegation depth zero; a limit of zero disables delegation. Later execution tickets enforce these limits; BOT-01 validates and persists them only.

## Access matrix

Every permission is intersected with current workspace membership. Workspace/group administration adds no implicit Bot permission.

| Bot access | Discover metadata | Inspect/use | Edit identity/avatar | Manage ACL/visibility | Manage lifecycle |
| --- | --- | --- | --- | --- | --- |
| Owner | Yes | Yes | Yes | Yes | Yes |
| Editor | Yes | Yes | Yes | No | No |
| User | Yes | Yes | No | No | No |
| No ACL, workspace-visible | Yes | No | No | No | No |
| No ACL, private | No | No | No | No | No |

- Discovery metadata is limited to name, persona, description and capability label; it excludes instructions, configuration and connection IDs. Explicit users can inspect reviewable instructions/limits, consistent with BOT-05 copy previews. Credentials and private memory are always excluded.
- Provide narrow fresh checks for `discover`, `inspect`, `use`, `edit`, `manageAcl` and `manageLifecycle`. BOT-02 consumes edit authorization for avatar changes and read authorization for private avatar delivery. Lifecycle operations arrive in BOT-06.
- Mutations lock workspace, then Bot, and re-read current actor membership/ACL, target eligibility and eligible-owner count. Provider admission follows its established scope ordering. Mutation and mandatory audit share the same transaction.
- New grants/promotions require a current same-workspace member. Protect the last owner who currently has workspace access; inactive retained owners do not satisfy that guard.
- Workspace removal remains possible and immediately denies Bot access. Retain explicit ACL history; a real invitation/rejoin may restore an otherwise unchanged grant. Do not auto-promote administrators or recover an orphaned owner silently.
- Canonicalize validated UUIDs and use persisted IDs in audit metadata. Effective ACL/visibility changes append safe before/after audit events; no-op requests need no duplicate event.

## Shared implementation boundaries

- BOT-02 and BOT-04 may proceed in isolated branches once BOT-01 is integrated. Both use the same fresh authorization/transaction boundary; neither introduces an administration bypass.
- Avatar changes must append immutable versions and atomically advance the current pointer. Cleanup must preserve every retained version reference so BOT-03 can restore history.
- BOT-03 public configuration edits must not accept arbitrary storage object IDs or keys. Avatar references change through authorized upload/removal or restoration of a retained version of the same Bot. Internal version append preserves validated references; guessing another private Bot's object ID must not attach its image.
- COL-02 group invocation uses an explicit group-Bot grant, separate from direct Bot ACLs. Group membership cannot grant direct configuration inspection, copying, editing or ACL management. Group history bounds and grant lifecycle remain COL-02 work.
- Native PostgreSQL evidence must cover concurrent ownership changes, waiting-actor revocation and audit rollback. Fixture tests do not prove database locking.

## Version append handoff for BOT-02 and BOT-03

- BOT-02 introduces an internal transaction-owned append operation for avatar changes; BOT-03 later reuses it for edits/restoration. Require `expectedCurrentVersionId`, lock workspace then Bot, recheck actor/ACL, and compare the persisted pointer before treating any request as a no-op.
- Construct the complete next configuration from the current version and an allowlisted typed change. Clients cannot supply author, sequence number, timestamps or arbitrary persisted metadata. Insert a fresh version UUID with number `current.number + 1`, advance the pointer and append the mandatory audit atomically. Keep unique `(bot_id, number)` and the deferred composite pointer constraint.
- An avatar-only change may proceed while the unchanged model is unavailable. Ordinary edits require fresh provider admission when the request explicitly supplies a model binding. Restoration always checks current connection-use authority, enabled state, verified Basic and the exact source model ID on the same SQL connection. Never silently substitute a model, fall back or re-probe.
- Restore accepts `sourceVersionId` from the same Bot and the current-version precondition. It appends a version with the current actor/time and `restoredFromVersionId` audit provenance; it never rewinds the pointer. Explicit restore appends even if configurations match. Other effective no-ops return the current version without another audit after checking the precondition.
- Default rationales are `Avatar updated`, `Avatar removed`, `Configuration updated` and `Restored version N`; optional user rationale is bounded to 500 characters. Sample version timestamps after admission. Audit changed field names and version IDs rather than full instructions/configuration.
- Preserve every retained-version avatar reference. Stage upload I/O outside database locks, then reauthorize and check the version before publishing its reference. Conflicts/rollback preserve the previous pointer and clean up the unused staged object. A missing historical avatar causes a controlled restore failure, not silent omission.
- Historical inspection/comparison needs current same-Bot inspect permission but not current provider availability. Compare only safe identity, instructions, binding, avatar and individual limit fields; exclude raw provider records, credentials, memory, ACLs and audit internals. Configuration restoration cannot unarchive or undo deletion.

## Group grant revocation handoff for COL-02

- Adding a Bot requires current group-management permission and direct Bot use; removal requires current group-management permission. A group grant records its granting user and authorizes only indirect use inside that group, never direct inspection, copying, editing or ACL management.
- Every indirect invocation/context admission checks the active grant, the current requesting user's group/workspace access, and the grantor's current workspace membership and direct Bot use. Provider use still belongs to the actual requesting human; no implicit grantor credential proxy is created.
- Revoking the grantor's direct Bot ACL or removing that user from the workspace permanently closes the affected group grants in that same mutation transaction. COL-02 adds these integration hooks to BOT-04/WS-03 when the grant schema and shared ledger exist; BOT-04 needs no speculative ACL-version migration now. Append the closure event/audit with the shared ledger position and established lock order.
- Rejoining a workspace or receiving a new direct Bot ACL does not reactivate a closed group grant. Explicit reinvitation by a currently authorized group manager creates a new grant and new history boundary. Queued Tasks pinned to the old grant cannot silently switch to the replacement grant.
- Keep current checks as well as durable closure. No cached permission or background invalidation delay may authorize another request after revocation commits. Configuration versions and historical authorship remain unchanged.
- When COL-02 introduces these hooks, gather affected group IDs while holding the workspace lock, lock groups in a stable order, then perform the final Bot admission and conversation closures. Do not append group/conversation locks after an already-acquired Bot lock merely to attach a callback to today's ACL repository; adapt the transaction entry point to preserve workspace → group → Bot → conversation ordering. The workspace lock prevents grant writers from changing that affected-group set during admission.
