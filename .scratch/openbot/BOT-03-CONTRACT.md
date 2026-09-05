# BOT-03 API and UI handoff

Base: `f0f9383fd299873134f332962d4c14f55b38fdd8`. No migration is required: immutable versions, avatar references, pointer grants and audit schema already exist. Do not alter published migration0013; COL-03 owns0014.

All routes live under `/api/v1/workspaces/:workspaceId/bots/:botId`. Require a session and current workspace membership intersected with explicit Bot ACL. GET/HEAD requires inspect (owner/editor/user); edits/restores require owner/editor. Discovery-only workspace members cannot inspect any history. Mutations require exact trusted Origin. Every response is private/no-store and nosniff. UUIDs are canonicalized.

| Operation | Request | Success |
| --- | --- | --- |
| Edit | `PATCH /configuration`, `{expectedCurrentVersionId,changes,rationale?}` | `{version}` |
| History | `GET /versions?before=<number>&limit=<1..100>`; optional cursor, default50 | `{currentVersionId,versions,nextBefore}` |
| Historical version | `GET /versions/:versionId` | `{version}` |
| Compare | `GET /versions/compare?fromVersionId=<UUID>&toVersionId=<UUID>` | `{fromVersionId,toVersionId,differences}` |
| Restore | `POST /versions/restore`, `{expectedCurrentVersionId,sourceVersionId,rationale?}` | `{version}` |

`version` is the existing BotVersion DTO: `{id,number,author:{id,displayName},createdAt,rationale,configuration}`. HTTP createdAt is ISO string. `versions` history entries omit configuration, are strictly descending by number, and carry author/time/rationale. `nextBefore` is null or the oldest number on the returned page, for fetching older entries; the current-version pointer is a fresh read, never a mutation precondition supplied by the server on the client's behalf.

`changes` is a partial allowlisted object: name, roleDescription, description, instructions, complete modelBinding, and/or partial limits. No avatarObjectId, storage keys, ACLs, visibility, lifecycle state, author, sequence number or timestamps are accepted. Use existing field/range limits. Rationale is optional and at most500 characters; blank selects the appropriate default. Unchanged fields and current avatar reference are retained.

A model binding is checked freshly on the mutation SQL connection whenever a patch explicitly includes modelBinding, even if the value is unchanged; all restores re-admit enabled/use/verified Basic/exact source model. UI must default to **Keep current model** and omit modelBinding unless the user deliberately chooses a model. This lets users edit unrelated fields while an unchanged binding is unavailable. Never treat a preview/catalogue result as authority.

CAS precedes no-op; effective ordinary no-ops return the same version with no extra audit. A restore always appends a new UUID and `current.number + 1`, even when source configuration equals current. Defaults: `Configuration updated` / `Restored version N`. Restoration references only the same Bot's immutable source version and requires the actual historical image to be readable, plus its retained same-Bot live reference under the final transaction. It never rewinds pointers, edits old versions or changes ACL/visibility/lifecycle.

`differences` is a safe ordered array of `{field,before,after}` with scalar string/number/null values. Field order: name, roleDescription, description, instructions, modelBinding.scope.kind, modelBinding.scope.id, modelBinding.connectionId, modelBinding.modelId, avatarObjectId, limits.maxTotalTokens, limits.maxDurationSeconds, limits.maxTurns, limits.maxDelegationDepth. Only changed fields appear. Missing and null avatar references both mean the default. Render escaped text, preserve instruction whitespace, and label each field clearly. Avatar previews use the existing private same-origin Bot/version route; never construct object-storage URLs.

Errors are fixed: 401 authentication_required;403 invalid_origin/bot_forbidden;400 invalid_bot_version_request (and framework413/415 for body limits);404 bot_version_not_found;409 bot_version_conflict or bot_avatar_unavailable;400 bot_model_unavailable with safe reason disabled/binding-changed/capability-unavailable/not-accessible;503 bot_version_unavailable. A transport error or unreadable 200 response is an unconfirmed mutation, so recommend reload to inspect current state before retrying; do not promise rollback.

API JSON body limits are256KiB for edits and4KiB for restores. BFF should use strict DTO validation, bound response bodies (1MiB safely covers comparison/max history metadata), enforce an upstream deadline through body consumption, refuse redirects, validate browser Origin before constructing internal Origin, and clear sessions only on true401. No UI endpoint changes API/model selection implicitly after a conflict; keep draft inputs and offer reload.

Implementation seam: `BotVersionService(pool, avatarReader, clock)` exposes edit/restore/get/list/compare on validated BotAccess. `appendBotVersion(connection,access,change,clock)` now accepts existing avatar changes or discriminated configuration/restore changes. Fresh authority, current-version CAS, model admission, validated avatar reference, immutable version/current pointer/reference/cleanup and safe audit all share the SQL transaction. Audit includes changed field names and version IDs; restore adds restoredFromVersionId. No instructions or image bytes enter audit metadata.
