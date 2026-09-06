# PROV-02 workspace model API contract

Base: `/api/v1/workspaces/:workspaceId/model-connections`.
Authenticated sessions remain valid even when `identity.workspace` is null. Every route performs
fresh access checks for the workspace in the path. Mutations require the trusted web Origin.
Responses use `Cache-Control: private, no-store`.

## Operations

- GET base →200 `{canManage, connections: SharedConnectionView[]}` for current members.
- GET `/:id` →200 `{canManage, connection: SharedConnectionView}` for current members.
- POST base →201 `{canManage, connection}` after owner/administrator test-and-save.
- PUT `/:id` →200 `{canManage, connection}` after owner/administrator test-and-save update.
- PATCH `/:id` with `{enabled:false}` →200 `{canManage, connection}` for owner/administrator.
- POST `/:id/test` with no body →200 `{report: PublicProbeReport}` for current members, including
  owner/administrator. This is usage permission; it accepts no credential override fields.
- No workspace DELETE route. Disabled records remain available for references with explicit
  `availability: "unavailable"`; new tests return409 `connection_disabled`.

Create fields match personal providers: `name`, `baseUrl`, `modelId`, `apiKey`, `headers`, explicit
`protocol` (`openai-chat`, `openai-responses`, `anthropic-messages`), optional `anthropicVersion`.
Update preserves credentials when omitted. Empty key explicitly clears the key; `{}` clears headers.
Anthropic version defaults to `2023-06-01` and appears in saved settings only for that protocol.

## Safe response types

```ts
type PublicProbeReport = {
  testedAt: string;
  text: { ok: boolean; code: string };
  action: { ok: boolean; code: string };
};
type SharedConnectionView = {
  id: string;
  name: string;
  protocol: 'openai-chat' | 'openai-responses' | 'anthropic-messages';
  modelId: string;
  availability: 'available' | 'unavailable';
  lastProbe: PublicProbeReport;
  settings?: ConnectionMetadata; // Present only when canManage === true.
};
```

`ConnectionMetadata` is the existing safe personal connection shape (protocol, optional Anthropic
version, id, name, baseUrl, modelId, enabled, apiKeyConfigured, headerNames, lastProbe with redacted
raw evidence). No plaintext key/header value or ciphertext appears in any response. Member views
omit settings entirely, including base URL, header names, configured flags, and raw probe evidence.

Errors are `{error:{code}}`:401 authentication_required;403 workspace_forbidden or invalid_origin;
404 connection_not_found;409 connection_disabled/connection_conflict;400 invalid_connection or
provider_url_not_allowed;503 providers_not_configured/provider_operation_failed/
provider_credentials_unavailable. Upstream capability failures are safe report codes, not raw errors.

## Web implementation boundary

New workspace model settings page: `/app/workspaces/[workspaceId]/models`. Load current workspace
through the existing workspace API, then this list. Owner/administrator render create/edit/disable
and test controls. Members render only the public model/capability/health view and test controls.
Unavailable connections show their retained identity and disable test controls. The workspace's main
page links to this page for every current member. The new BFF client must set JSON Content-Type only
when a request has a body, and keep the timeout active through response JSON consumption.
