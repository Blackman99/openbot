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
- COL-02 group invocation uses an explicit group-Bot grant, separate from direct Bot ACLs. Group membership cannot grant direct configuration inspection, copying, editing or ACL management. Group history bounds and grant lifecycle remain COL-02 work.
- Native PostgreSQL evidence must cover concurrent ownership changes, waiting-actor revocation and audit rollback. Fixture tests do not prove database locking.
