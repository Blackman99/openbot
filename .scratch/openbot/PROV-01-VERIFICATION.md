# PROV-01 verification and integration handoff

## Implemented slice

Personal OpenAI Chat-compatible connections now have authenticated API and settings routes for
creation, owner-only inspection/listing, editing, retesting, disabling and deletion. Test-and-save
performs live text SSE and structured-action probes before persistence. Failed text remains
saved but disabled; text-only providers remain enabled when the action probe is unsupported.

Credentials use AES-256-GCM with a fresh random nonce and owner/connection-associated data.
Only configured flags and header names leave the service; probe evidence is redacted. Endpoint
schemes and exact hosts are allowlisted; all DNS results are checked for forbidden/private
addresses before the selected IP is pinned to the outgoing request. Redirects and inherited
proxy behavior are not used. Optimistic revisions prevent late tests or updates from undoing a
newer disable/credential rotation. Database mutations and minimal audit records share a transaction.

Migration `0004_personal_model_connections` follows published workspace migration0003. Production
runtime configuration, Compose environment, restricted database privileges and README setup
instructions are included. Empty encryption-key configuration disables provider capability without
blocking the rest of OpenBot.

## Verification witnessed in this resumed session

- Preserved retained implementation as checkpoint `1694f0b`, then reconciled provider/workspace
  wiring and shared migrations against current integration. Original pre-pause red/green history
  was retained rather than recreated or misreported as a new test run.
- Browser RED: workspace setup redirected to its explicit workspace route; after updating that
  expectation, the new **Personal models** navigation assertion failed because the link was absent.
  GREEN: added the workspace link, and the whole CRUD browser scenario passed.
- HTTP RED: malformed provider JSON returned the generic parser envelope rather than the safe
  provider error contract. GREEN: provider-scoped error handling returns a stable error code and
  `Cache-Control: private, no-store`, including failures before the route handler.
- Updated the existing environment-contract expectation for the four provider settings.
- Full `pnpm verify` passed: API50 unit +54 integration, Web8 unit +29 integration =141 tests;
  all6 browser scenarios; formatting, TypeScript/Svelte checks, API and web production builds.
  Svelte diagnostics:0 errors and0 warnings. Existing build timing/empty-chunk notices remain.
- Live HTTP mock coverage includes successful text/action probes, authentication errors, timeouts,
  cancellation, interrupted/error streams, redirects and bounded response size. Persistence tests
  cover ciphertext, owner isolation, mutations/audits, forbidden input, cancellation and stale writes.

## External gate still pending

`apps/api/tests/postgres/provider-runtime.test.ts` must pass on real PostgreSQL17 through the
`postgres-providers` Verify job. It uses a dedicated `TEST_PROVIDER_DATABASE_URL`, applies migrations
and the real restricted-role script, then verifies encrypted persistence, ownership, revision
conflict handling, audit-failure rollback, deletion and forbidden runtime DDL/audit updates.
The local environment does not provide PostgreSQL or Docker; no successful real-PG or Compose
execution on this provider change is claimed. Root must record the actual PR CI evidence before
calling the ticket fully complete. The existing `postgres-auth` and `compose` jobs must remain green.

## Public seams for PROV-03 and PROV-04

- `apps/api/src/providers/openai-chat-probe.ts` exports `ConnectionProbe`, `ProbeInput`,
  `ProbeReport` and `ProbeResult`. The current `run(input, AbortSignal?)` contract returns separate
  timestamped text/action evidence. It has a15-second total deadline and65,536-byte response cap.
- `ProviderConnections` owns input validation, authorization through owner-scoped repositories,
  credential encryption/decryption, before-save probing, safe evidence and optimistic mutations.
  `ProviderRepository` is the persistence boundary; reuse it instead of adding protocol-specific
  storage paths.
- `ProviderUrlPolicy.validate/resolve` is the shared destination policy. The actual pinned-IP HTTP
  transport currently lives in private `OpenAiChatProbe.send`; coordinate one extraction if needed
  for new protocols. Do not create an unguarded `fetch` implementation for each protocol.
- Current connections are implicitly OpenAI Chat. Explicit protocol selection belongs in the next
  adapter tickets. Coordinate changes to `ConnectionInput`/metadata/parsing, production dispatch
  in `runtime.ts`, the Web API decoder and settings fields. Existing records need a compatible Chat
  default; avoid conflicting edits by assigning these shared files to one integration owner.
- Shared files requiring coordination: `connections.ts`, `openai-chat-probe.ts`, `runtime.ts`,
  `apps/web/src/lib/server/provider-api.ts`, model settings server/Svelte pages, browser provider
  fixture and the migration ledger/Compose assertions if a migration becomes necessary.
- Independent protocol mock tests can live in separate new files. Reuse network policy, redaction,
  cancellation and bounded evidence contracts. Preparatory protocol details are in
  `PROVIDER-PROTOCOL-NOTES.md`; this ticket does not implement Responses or Anthropic.
- Browser ports4399/4173 require a root-assigned exclusive lease; this ticket's suite is finished
  and the lease has been released. Real PostgreSQL suites need separate disposable databases.

## Independent review — Standards axis

Reviewed pinned base `027b6af` → `0258f91`, independently from spec completeness.

> P1 — Bound redaction without reprocessing replacement text. `secrets.ts:46–55` violates the
> transport's bounded handling of untrusted responses. Twenty custom headers containing `E` are
> accepted; replacement matches the two `E` characters inside its own `[REDACTED]` marker,
> exponentially expanding the string. Probe and service both apply redaction. Eight headers valued
> `E` expanded a one-character input to2,296 bytes and589,816 bytes after the second pass.
> Match original text once, deduplicate credential variants, bound output and repeated redaction.
> No additional actionable standards findings in owner isolation, transactions or server rendering.

Fix: a single escaped-literal matching pass deduplicates credential variants, treats existing masks
as terminal, and bounds evidence to65,536 UTF-8 bytes without emitting a partial code point.
Regression `keeps repeated redaction bounded and stable for duplicate short credentials` was red
with the nested-mask explosion, then green. `caps UTF-8 evidence without producing a partial code
point` also failed before the streaming TextDecoder boundary fix, then passed.

## Independent review — Spec axis

Reviewed the same pinned diff separately against all seven ACs and non-goals.

> P1 — Normalize sensitive header values before redaction. Accepted surrounding header whitespace
> is trimmed by HTTP; reflection of the transmitted value therefore escaped the exact-string
> redactor and was persisted as raw error evidence. Violates AC3's masked reads and AC4's secret
> exclusion from logs/errors/audits/exports.
>
> P2 — Preserve received evidence when a stream breaks. The response-error handler rejected
> without the accumulated chunks, leaving `raw` empty despite a received `partial OK` SSE frame.
> The previous interrupted-stream mock ended normally. Preserve bounded sanitized partial evidence
> alongside the transport failure. Violates AC2's timestamped raw probe results.
>
> No other actionable requirement gaps. Pending actual PostgreSQL evidence is a verification
> limitation, not a demonstrated implementation defect.

Fixes: redaction includes original and HTTP-trimmed credential values; transport completion retains
bounded chunks and a failure code even on socket errors. New live HTTP regressions
`redacts header secrets after HTTP whitespace trimming` and
`retains sanitized partial raw evidence when the response socket breaks` each failed on the
reported behavior before the minimal implementation change, then passed. The latter mock sends
an SSE frame and actually destroys its socket.

Final review-fix verification runs formatting, all API types,52 API unit tests,56 API integration
tests and the API production build. The previously verified unchanged web remains8 unit +29
integration tests and6 browser scenarios:145 unit/integration tests in the final combined tree.
Root performs the focused recheck of these three findings after receiving the final commit SHA.
