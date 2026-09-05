# BOT-01 implementation API and UI contract

This records the implemented Web/API contract for BOT-CONTRACT. Both independent reviews and the combined local gate are complete; actual PostgreSQL/Compose evidence remains BOT-01-E1 in BOT-01-VERIFICATION.

## Endpoints

All routes require a session cookie and respond with private/no-store. POST requires the configured exact Web Origin. Validated UUID inputs are canonicalized; API and Web parsers accept uppercase UUID spelling and preserve canonical output.

- `POST /api/v1/workspaces/:workspaceId/bots` accepts the configuration below, returns 201 `{ bot: BotDetail }`, and always creates a private Bot with the creator as sole owner and current version 1.
- `GET /api/v1/workspaces/:workspaceId/bots` returns 200 `{ bots: BotSummary[] }`.
- `GET /api/v1/workspaces/:workspaceId/bots/:botId` returns 200 `{ bot: BotDetail }` for explicit ACL members; discovery-only viewers receive `{ bot: BotSummary }` without `currentVersion`.

```ts
type BotConfiguration = {
  name: string; roleDescription: string; description: string; instructions: string;
  modelBinding: {
    scope: {kind: 'personal'|'workspace'; id: string};
    connectionId: string; modelId: string;
  };
  limits: {
    maxTotalTokens: number; maxDurationSeconds: number;
    maxTurns: number; maxDelegationDepth: number;
  };
};
type BindingStatus =
  | {state:'ready'; chatOnly:boolean}
  | {state:'unavailable'; reason:'disabled'|'binding-changed'|'capability-unavailable'|'not-accessible'};
type BotSummary = {
  id:string; workspaceId:string; visibility:'private'|'workspace';
  accessRole:'owner'|'editor'|'user'|null;
  name:string; roleDescription:string; description:string; bindingStatus:BindingStatus;
};
type BotDetail = BotSummary & {currentVersion:{
  id:string; number:number; author:{id:string;displayName:string}; createdAt:string;
  rationale:string; configuration:BotConfiguration;
}};
```

Creation may omit description (defaults empty) and all or some limits (defaults below). Other fields are required. Unknown fields, client-supplied identity/version/ACL/visibility fields, non-integer limits and invalid scope identifiers are rejected. Instructions preserve their submitted formatting; name/role/description are trimmed. Scope must be the actor's personal scope or this exact workspace. No guessed alternative model, provider call or fallback substitution occurs on creation/read.

| Field | Bound/default |
|---|---|
| name | 1–100 characters after trimming |
| roleDescription | 1–200 characters after trimming |
| description | up to 2,000 characters |
| instructions | nonblank, up to 32,000 characters; preserve formatting |
| modelBinding.modelId | nonblank, up to 256 characters, matching the selected provider model |
| maxTotalTokens | default 32,768; 1–1,000,000 |
| maxDurationSeconds | default 300; 1–3,600 |
| maxTurns | default 8; 1–100 |
| maxDelegationDepth | default 2; 0–8, zero disables delegation |

Errors: 400 `{error:{code:'invalid_bot_request'}}`; 400 `{error:{code:'bot_model_unavailable',reason:BindingStatusUnavailableReason}}`; 401 `authentication_required`; 403 `invalid_origin` or `bot_forbidden`; 503 `bot_unavailable` for unexpected storage failures. Other transport/server errors render unavailable without exposing their response text. Valid sessions remain intact on 403. Only genuine 401 clears the cookie.

## Web child boundary

- Own new `apps/web/src/lib/server/bot-api.ts` with `BotApiClient.create(session,workspaceId,input)`, `.list(session,workspaceId)`, `.get(session,workspaceId,botId)`. Use result `available/value`, `anonymous`, `forbidden`, `invalid`, `model-unavailable/reason`, or `unavailable`. Parse strict allowlisted response shapes and scoped UUIDs. Keep the deadline through JSON consumption; set Content-Type only for body-bearing requests.
- Own new `bot-page.ts`, `/app/workspaces/[workspaceId]/bots` list/create and its `/[botId]` detail page, navigation, corresponding Web tests, and an isolated Bot fixture hook/browser scenario. Do not edit existing auth/provider/capability/group/token business clients or API modules.
- For model choices, reuse the existing personal provider list, workspace provider list, and `CapabilityApiClient.get(session,connectionId,workspaceId?)` catalog. Send only safe selector fields to the browser: scope, connection/model ID, display name and current enabled/Basic/Collaboration status. No raw settings, headers, endpoint credentials, evidence bodies or fallback graph. Disable unavailable/unverified choices and link to the existing model configuration/capability pages. Do not automatically probe or add a Bot-specific provider endpoint.
- Display name/persona/description, current viewer-specific model status, and current version/instructions/binding/limits only for explicit ACL viewers. Never use a creation-time capability badge as a current claim. Ready Basic shows “Chat-only — unsuitable for reliable delegation”; ready Collaboration shows “Collaboration-capable”; unavailable status gets a safe corrective explanation without claiming current capability.
- Creation is private only; no edit, upload, permission-management, chat, task, memory or execution controls. Show version 1 and the persisted limits on detail. Do not claim those limits are already executed or enforced.
- Preserve every existing fixture hook/reset, including signed OIDC and scoped-token additions. Browser ports 4399/4173 require root lease. Child must obtain lease through the parent before any browser run.

## Parent obligations

The parent owns API/storage/model admission, runtime wiring, migration0012/native immutable-version and same-Bot pointer constraints, current permission/transaction seams, UUID/current-status/real-HTTP/atomic-failure tests, and actual PostgreSQL tests. Parent and root arrange both independent review axes and integrated Compose evidence. No child pushes, root-worktree changes, or ticket-index/progress/REL edits.
