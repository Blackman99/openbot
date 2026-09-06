# PROV-05 capability and fallback contract

Applies to both `/api/v1/model-connections/:id` (personal owner) and
`/api/v1/workspaces/:workspaceId/model-connections/:id` (current workspace member).
All responses remain private/no-store. Existing metadata/list and member saved-credential `/test`
contracts stay unchanged. New mutation endpoints require the connection owner or workspace
owner/administrator, the trusted Origin, and current optimistic `expectedRevision`.

## Catalog

GET `/policy` returns the object below directly. New probes prove only text, streaming, and reliable
toolCalling. structuredOutput and visionInput start unknown; protocol/model/endpoint names never
imply optional capabilities. Legacy connections need verification until an attributable probe runs.

```ts
type Flag = 'text' | 'streaming' | 'toolCalling' | 'structuredOutput' | 'visionInput';
type Requirement = 'basic' | 'collaboration' | 'visionInput';
type Override = {
  value: boolean; rationale: string; actorUserId: string;
  createdAt: string; generation: number; active: boolean;
};
type Evidence = {
  status: 'supported' | 'unsupported' | 'unknown';
  source: 'probe' | 'manual' | 'unknown';
  evidence: string; actorUserId: string | null; observedAt: string | null;
  lastProbedAt: string | null; manualBadge: boolean; override?: Override;
};
type Catalog = {
  id: string; name: string; protocol: 'openai-chat' | 'openai-responses' | 'anthropic-messages';
  modelId: string; enabled: boolean; canManage: boolean;
  revision: number; generation: number;
  basic: boolean; collaboration: boolean; enhanced: { visionInput: boolean };
  flags: Record<Flag, Evidence>; lastProbedAt: string | null;
  fallbacks: { requiredCapability: Requirement; connectionIds: string[] };
};
```

Basic requires supported text AND streaming. Collaboration additionally requires supported toolCalling
OR structuredOutput. Vision requests require Basic AND supported visionInput. Enhanced is a named
optional feature group, not an inferred tier: use the visionInput flag's status to display unknown
versus unsupported. A Basic-only model must never resolve Collaboration work.

Each target-changing edit (protocol, base URL, model ID, version, key, or headers) advances generation.
Name-only edits, probes, disable, overrides, and fallback changes do not advance target generation.
Old manual overrides remain visible with a persistent badge and `active:false` but cannot grant
capabilities to the changed target. Re-probing retains manual overrides/history; current active
manual values take precedence over probed values. Every saved proof and manual change has actor/time
and immutable audit evidence. No catalog or audit contains credentials, header names, or raw bodies.

## Mutations

- POST `/overrides`: `{expectedRevision, capability: Flag, value: boolean, rationale: string}`.
  Rationale is trimmed, required, and at most500 characters. Known request secrets are redacted.
- PUT `/fallbacks`: `{expectedRevision, requiredCapability: Requirement, connectionIds: string[]}`.
  At most16 distinct UUIDs, in priority order. IDs are canonicalized. Every candidate must be
  enabled, usable, and satisfy the required capability. Self references, duplicates, and cycles fail.
- POST `/reprobe`: `{expectedRevision}`. Uses the stored connection and shared actual protocol probe;
  disabled connections return409. The existing admin test-and-save edit can enable them again.

Each successful mutation returns the fresh Catalog directly. Missing/non-integer revisions or extra
input fields return400 `invalid_capability_policy`; stale revisions return409 `connection_conflict`.
Other policy error codes:400 `duplicate_fallback`, `fallback_cycle`, `fallback_unavailable`,
`fallback_capability_required`. Existing safe provider/auth/origin errors retain their statuses.
Member policy management is403; existing member `/test` usage remains permitted and attributable.

## Resolution preview

GET `/resolution-preview?capability=basic|collaboration|visionInput` returns:

```ts
type Preview = {
  primaryId: string; requiredCapability: Requirement;
  selectedId: string | null; order: string[];
  candidates: Array<{
    id: string; eligible: boolean;
    reason: null | 'disabled' | 'capability_unknown' | 'capability_unsupported' | 'not_accessible';
    name?: string; protocol?: Catalog['protocol']; modelId?: string; revision?: number;
    basic?: boolean; collaboration?: boolean;
  }>;
};
```

Candidates appear in deterministic depth-first order: primary, then each configured fallback and
its descendants, preserving configured order and visiting a node only once. `order` contains eligible
IDs only and `selectedId` is its first ID or null. Missing/deleted/out-of-scope candidates show only
ID/eligibility/reason, never another scope's metadata. Current access, enabled state, and effective
capabilities are rechecked on each preview under the graph's scope lock. No provider request,
retry, or model switching occurs. Disabled/ineligible nodes are excluded but their accessible
configured descendants can still be evaluated.

All fallback references stay within one personal owner's connections or the same workspace.
No shared workspace fallback can use any personal connection or another workspace's connection.
The UI must state this rule. Cycle validation and mutation are atomic under a shared scope lock;
concurrent opposite graph edits cannot both commit.

## UI ownership

One isolated UI child may own new BFF client/page helpers, reusable capability editor, tests, and
links from both model lists. Suggested pages:
`/app/settings/models/[connectionId]/capabilities` and
`/app/workspaces/[workspaceId]/models/[connectionId]/capabilities`.
Use existing list endpoints for same-scope model choices; server validates capability compatibility.
Show Basic/chat-only versus Collaboration, unknown Enhanced flags, actor/time/evidence, persistent
manual badges including stale overrides, explicit ordered fallbacks, and preview exclusions.
Only canManage users see override/reprobe/fallback controls; every current member may inspect and
preview. Preserve blank-secret handling in existing forms by leaving those forms' behavior intact.
New BFF requests set Content-Type only when a body exists and retain the timeout through JSON reads.
Child must request the parent's exclusive browser lease before binding4399/4173.

## Internal durable binding admission

`apps/api/src/providers/postgres-model-admission.ts` exports
`admitUsableModel(connection: SqlConnection, access: ConnectionAccess,
{connectionId, expectedModelId})`. The caller owns an existing transaction and first acquires its
workspace lock; admission then acquires the provider scope lock, checks current usage authority,
enabled state, effective Basic capabilities, and the expected immutable model ID. All provider
configuration/policy writers share that lock, which remains held until the caller commits its
related durable write. Personal scopes use advisory namespace 739105 without users-row UPDATE
privileges. Workspace scopes reuse their workspace row lock and current membership.

The safe result is `{scope, connectionId, modelId, chatOnly}`. It contains no credentials or private
provider configuration. Credential rotation does not pin or invalidate a model ID binding; a model
ID change returns `model_binding_changed`. Missing Basic proof returns `model_capability_required`;
disabled or inaccessible connections use existing safe errors. This is an internal repository seam,
not an HTTP endpoint or arbitrary public SQL callback. Resolution previews remain non-durable
snapshots. No Bot or execution retry behavior is implemented here.
