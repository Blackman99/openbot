# PROV-04 implementation and review handoff

## Scope

Anthropic Messages is an explicit personal-connection protocol. The adapter posts to `/messages`,
uses `x-api-key` and the configured `anthropic-version`, converts system messages to the top-level
system field, and maps local tool definitions to `input_schema` and a forced `tool_choice`.
The default version is `2023-06-01`; users can edit and persist another valid date version.
Conflicting key/version headers and malformed versions are rejected before probing.

The parser normalizes plain messages and incremental SSE into shared text, structured-action,
cumulative usage, and completion events. Tool JSON fragments are isolated by content index and
parsed only at block completion. EOF without `message_stop`, malformed fragments, reused indices,
and upstream stream errors do not report successful completion. Unknown events are tolerated.
Only local `tool_use` blocks become actions; hosted tools and Computer Use are not executed.

The production protocol dispatcher uses the same pinned DNS transport, timeout/cancellation,
response budgets, error categories, probe validation, and credential-redaction path as the OpenAI
adapters. Diagnostic raw text is sanitized; actual generated model content retains its semantics.
Text-only endpoints stay enabled with persisted `provider_action_unsupported` evidence.

No migration was needed: protocol and version use the existing encrypted-credential/JSON-metadata
repository. No paid endpoint was called.

## Base and integration

Started from root `f5a5c71`. PROV-03 shared commits were cherry-picked before final glue:

- `a855726` → local `141decf`: shared model events, pinned transport, dispatch and settings.
- `977b949` → local `cba17ce`: completed action stop reason required for capability probes.
- `271aa4a` → local `e29cc93690f048a0ce4b9544624eef91989837a5`: separate generation/diagnostic
  budgets and complete SSE line-ending support.

The Anthropic-only review base is `e29cc93690f048a0ce4b9544624eef91989837a5`.
Root should integrate only the subsequent Anthropic commit after integrating PROV-03.
Temporary shared-file copies were removed before cherry-picking; none remain untracked.

## Witnessed TDD and validation

- Plain-message RED returned no events; GREEN normalized text, usage and stop reason.
- Tool RED omitted structured actions; GREEN preserved IDs, names and object arguments.
- Invalid usage RED accepted negative/noninteger counts; GREEN rejects them.
- Streaming RED returned no incremental text; GREEN delivers text before upstream completion.
- Fragmented-tool RED omitted completed actions; GREEN independently assembles each content index.
- Error-event RED returned the wrong class; GREEN normalizes rate limits, overload and authentication.
- Malformed JSON and reused-index RED failed; GREEN uses stable errors and rejects duplicate indices.
- HTTP adapter RED emitted no events/request; GREEN verified actual local POST payload and headers.
- Forced-tool RED omitted request schemas; GREEN sends Anthropic tool syntax.
- Protocol-dispatch RED rejected Anthropic; GREEN uses the production shared probe path.
- Persistence RED rejected the protocol; GREEN retains version edits, encrypted credentials and
  unsupported-action evidence. Validation rejects conflicting headers and invalid date versions.
- Web decoder/action/render RED rejected or omitted version metadata; GREEN preserves safe fields.
- Browser RED exposed Svelte interpolation removing braces from the HTML version pattern, preventing
  submission for both protocols. GREEN uses an explicit pattern string, with an SSR regression.
- Full `pnpm verify`: API68 unit +102 integration, Web8 unit +30 integration =208 tests; all7 browser
  scenarios, formatting, API/Web typechecks and production builds. Svelte diagnostics:0 errors and
  0 warnings. Existing Vite timing/empty-chunk and NO_COLOR notices are unchanged.

The33 dedicated Anthropic parser/HTTP tests cover plain text, live streaming before EOF, tool_use,
interleaved tool arguments, cumulative usage, malformed/incomplete streams, unknown events,
cancellation/socket close, timeout, HTTP401/403/429/529/500/400/302, in-stream overload and sanitized
reflected secrets. Existing shared tests cover URL policy, response budgets and stream line endings.

## Independent review and external evidence

Independent specification review of `e811f8bb2dccff8308a4608ab6698ecb3c70b503` against the pinned
base was clean across all six acceptance criteria. Independent standards review found one P3:
the Anthropic-version HTML pattern still prevented submission after selecting OpenAI Chat or
Responses. The other reviewed boundaries were clean; no runtime gate was rerun by reviewers.

The review regression selects Anthropic, enters `latest`, switches to Responses, and submits;
before the fix, native browser validation prevented creation. It repeats the same switch to Chat
while editing. The fix tracks protocol selection per form and disables the version field outside
Anthropic, leaving the server's strict Anthropic version validation unchanged. Both protocol browser
scenarios, three focused Web tests, seven provider-connection tests and Svelte typechecking pass after
the fix; the browser run also builds the production Web application. Independent standards recheck
was clean at `b58ec82c7edaa40d3c901e8c566f5eaa5cb6976c`; root checked the same narrow delta against the
already-reviewed acceptance criteria.

Integrated root revision `87632a1` passed 249 unit/integration tests, all 8 browser scenarios,
formatting, types and production builds. Actual PostgreSQL/Compose gate `PROV-04-E1` remains pending.

`apps/api/tests/postgres/provider-runtime.test.ts` now exercises both Responses and Anthropic,
including persisted version metadata, restricted-role ciphertext, stale revisions, ownership,
audit-failure rollback and forbidden runtime privileges. Actual PostgreSQL17 and Compose evidence
must run in Verify CI; no successful local PostgreSQL/Compose execution is claimed.

## Primary protocol references

Verified on2026-09-05:

- https://platform.claude.com/docs/en/build-with-claude/streaming
- https://platform.claude.com/docs/en/api/errors

The streaming source documents indexed content blocks, partial JSON tool input, cumulative usage,
`message_stop`, ping/unknown events and errors after HTTP200. OpenBot's approved ticket and shared
provider policy remain authoritative for storage, network isolation and redaction.
