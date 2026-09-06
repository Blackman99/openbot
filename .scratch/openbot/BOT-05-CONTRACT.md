# BOT-05 API and UI contract

The reviewed copy operation is a same-workspace configuration copy. It requires current workspace membership and an explicit Bot owner, editor or user ACL; workspace administration, discovery, and group grants provide no copy authority. An archived source remains inspectable for copying. A deleted source must be recovered by its eligible owner before copying. New copies are private and active.

All endpoints are under `/api/v1/workspaces/:workspaceId/bots/:botId`. They require a current session, canonicalize UUIDs, return `Cache-Control: private, no-store` and `X-Content-Type-Options: nosniff`, and require exact trusted Origin for mutation.

| Operation | Input | Success |
| --- | --- | --- |
| Preview | `GET /copy-preview` | `200 {preview}` |
| Confirm | `POST /copy`, `{expectedCurrentVersionId,modelBinding?}`; 4 KiB body limit | `201 {bot}` |

`preview` is exactly `{sourceBotId,sourceVersionId,sourceVersionNumber,configuration,bindingStatus,included,excluded}`. The configuration is the existing safe BotConfiguration DTO. `included` is exactly `['identity','instructions','executionLimits','avatarReference','modelBinding']`; `excluded` is exactly `['credentials','acls','history','memory','fileContents','audits']`. Model status is a fresh viewer-specific snapshot, never confirmation authority. No preview record or audit is written. Cancellation is navigation away from this read-only view.

Confirmation accepts only the preview's `expectedCurrentVersionId` and an optional complete `{scope:{kind,id},connectionId,modelId}` replacement. It never accepts a client configuration, arbitrary avatar object ID, destination owner, ACL, lifecycle, author, timestamps, history, memory, credentials or storage fields. An omitted replacement retains the source binding only after fresh actual-actor provider admission. Unavailable bindings require an explicit accessible replacement; there is no fallback or automatic reprobe.

The returned Bot DTO has a fresh stable ID, a fresh version ID numbered 1, current actor/time, rationale `Copied configuration`, private visibility, active lifecycle and the actor's sole owner ACL. Copy explicitly selects identity, instructions, limits and model fields instead of spreading persisted JSON. The source is unchanged. The mandatory `bot.copied` audit is content-free `{workspaceId,botId,versionId,version:1,sourceBotId,sourceVersionId}` with the actual actor/time; prior audits are never duplicated.

Confirmation's workspace → source Bot → provider scope → avatar object locks cover fresh ACL/membership, current-version CAS, exact model/use/enabled/verified Basic admission, new identity/version/pointer/owner/reference writes and the mandatory audit in one transaction. Failure before commit leaves no destination records or new object. An unreadable/failed response after submission is an unknown mutation outcome, not evidence of rollback.

A copied avatar reuses the source version's authorized, same-workspace, live retained reference without any object storage write. The source version must belong to the currently authorized source Bot. Configuration edits and restoration validate their same-Bot retained version reference plus the live same-workspace object, allowing the object's originating `bot_id` to differ after copy. Upload publication still requires the object's originating Bot. Public edit/create forms continue rejecting raw object IDs. Every immutable copied/historical reference protects the object from cleanup across all Bots.

Fixed errors: `401 authentication_required`; `403 invalid_origin` or `bot_forbidden`; `400/413/415 invalid_bot_copy_request`; `409 bot_version_conflict` or `bot_avatar_unavailable`; `400 bot_model_unavailable` with disabled/binding-changed/capability-unavailable/not-accessible; `503 bot_copy_unavailable`. No underlying database, credential, or storage errors are returned.

The browser route `/app/workspaces/:workspaceId/bots/:botId/copy` displays the reviewed version, exact included/excluded categories, escaped identity/instructions, limits, a private source Bot/version avatar route and model status. An unavailable source model disables retention and requires an accessible replacement. Confirmation is explicit; cancellation is a link. Conflicts preserve the submitted version/model and block confirmation until a fresh review. Unknown outcomes block repeat submission and ask the user to check the Bot list for a created copy. The BFF validates exact response shapes, enforces a 256 KiB response bound and 30-second deadline through body consumption, refuses redirects, checks browser Origin before internal Origin construction, and clears sessions only on genuine HTTP 401.

No BOT-05 migration or runtime privilege broadening is needed. BOT-06 supplies lifecycle schema/DTO; COL-02 supplies group-grant schema. Native PostgreSQL execution remains separately tracked in `BOT-05-NATIVE-EVIDENCE.md` until actual restricted-role CI passes.
