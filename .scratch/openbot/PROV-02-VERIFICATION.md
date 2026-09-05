# PROV-02 verification and handoff

## Scope and contract

Workspace connections use the existing encrypted connection engine and all three protocol adapters.
The engine now carries an explicit personal/workspace scope and an independent actor user ID.
Personal credentials retain the historical `${ownerUserId}/${connectionId}` authenticated encryption
context. Workspace credentials use `workspace/${workspaceId}/${connectionId}`, so a different
administrator can update or probe a shared connection without rebinding it to their identity.

Workspace membership is the usage grant. Owners and administrators manage; every current member
can list minimal model metadata and run a saved-credential probe. Members cannot submit credential
or URL overrides. The workspace API returns no credentials or ciphertext. Member list/detail and
probe responses exclude raw provider diagnostics, URLs, credential flags, and header names. Admin
settings contain only the existing safe configuration fields and redacted probe diagnostics.

The API response contract is documented in [PROV-02-API-CONTRACT.md](PROV-02-API-CONTRACT.md).
Disabled records retain their IDs and expose `availability: unavailable`. New probes fail with
`connection_disabled`. Dependent bots/groups do not exist at this ticket's dependency point; this
retained state is the reference boundary for those later consumers.

## Permission and persistence boundaries

`PostgresProviderRepository` authorizes inside a transaction, locking the workspace row before
reading current membership. This is the same lock order used by WS-03 role changes/removals.
Provider network work runs outside transactions. Each actual text/action request calls the shared
`ProbeAdmission` hook, which checks fresh membership, management authority when needed, enabled
state for usage, and the expected connection revision. A call already admitted may finish; the next
call cannot start after revocation/disable wins admission. The existing total probe deadline and
cancellation also interrupt a pending admission check without starting a provider request. Persisting
a result rechecks authority
and uses revision compare-and-swap, so late results cannot revive a disabled record or overwrite
an edited credential/configuration. Responses are projected again for current authority.

Successful writes and secret-free audits commit together. Workspace audit metadata includes only
workspace and connection IDs; the audit actor is the actual creating/editing/testing user. The
runtime role can select/insert and update only configuration/revision/timestamp columns in the new
table; it cannot reassign a connection to another workspace or delete its retained identity.

Migration `0008_workspace_model_connections` is provisionally reserved after AUTH-02's `0007`.
This isolated branch starts before AUTH-02 integration. The coordinator must reconcile only
unpublished migration ordering and the Compose expected ledger when integrating; do not insert a
migration before an already deployed ledger version.

## Red/green and local evidence

Baseline at `34d3e615ea0c41679fe0ffc7fe4ac9e4e8d5a22d`: 284 unit/integration tests and typechecks passed.

Witnessed failures then fixes:

- Scoped workspace creation initially failed because the engine had no `inWorkspace` entry point;
  scoped encrypted persistence and minimal member views made the lifecycle pass.
- Removing a member between text and action still invoked the provider twice; a disabled connection
  likewise made another call and failed only on persistence. Admission before each generation now
  blocks the second call and returns the current forbidden/disabled outcome.
- Pending admission initially ignored the probe timeout and cancellation; racing the pure
  authorization check against the existing abort signal now returns the classified outcome without
  starting either provider request.
- The workspace HTTP endpoint initially returned 404 for unauthenticated access; registered scoped
  routes made the protected lifecycle and member management 403 assertions pass.

Additional regression coverage exercises administrator changes with preserved credentials, late
management demotion and member removal, disabled identity retention, all three actual protocol
endpoints with real local 429 responses and redaction, role-specific HTTP projection, malformed and
cross-origin requests, cross-workspace/personal isolation, audits, and the Web client over real HTTP.
The latter covers all three protocols and bodyless member probes against Fastify rather than only
fetch mocks.

At API checkpoint `667f256`: formatting, all 294 unit/integration tests (API 68 unit + 135 integration;
Web 13 unit + 78 integration), typechecks, and API production build passed. The later Web client
checkpoint adds 24 focused tests, including malformed/private response rejection, bodyless
Content-Type handling, and a deadline retained through response body consumption. Its real HTTP
lifecycle regression and API typecheck pass.

## Combined candidate and review status

Combined code candidate `fb4d6ae79cc4489f1146b5fa339628400c9e8d76` passed all 331 unit/integration
cases across the recorded runs: API 70 unit + 137 integration; Web 17 unit + 107 integration. Formatting,
typechecks (Svelte 0 errors/warnings), serial API and Web production builds, and all ten Playwright
scenarios passed. The new two-user scenario covers owner creation, member minimal views and probes,
member management 403, administrator promotion/edit, all three protocols, disable/re-enable,
demotion, and removal with the underlying session retained. Ports 4399/4173 were confirmed closed
and the lease released after the full browser run.

The initial concurrent `pnpm test:integration` run hit the existing real-password authentication
case's five-second test deadline while API/Web suites ran together. Its isolated six-test file and
then the complete 137-test API suite passed unchanged when run serially. Exact recovery commands:
`pnpm --filter @openbot/api exec vitest run tests/integration/auth-service.test.ts` followed by
`pnpm --filter @openbot/api test:integration`. Root already carries the independent baseline fix
limiting API integration workers to four; the merger must preserve it. No timeout increase,
authentication weakening, or unrelated production change was made here.

Independent Standards review at `fb4d6ae` found one P2: uppercase UUID spellings selected the same
workspace row but produced different authenticated-encryption contexts. The reviewer otherwise
reported no findings and independently passed 14 focused API + 33 Web tests. Fixed code is
`73a4434112561ef6585ca3e108be8835f6cc4bb4`: workspace access/audit IDs are canonicalized at the scope
boundary, workspace credential contexts canonicalize equivalent UUID spellings, and updates retain
the stored canonical connection ID. The personal AAD formula remains byte-for-byte unchanged.

An actual HTTP regression first returned 503 when an uppercase-path-created connection was probed
through the canonical lowercase path. It now passes that round-trip, a different administrator's
uppercase workspace/connection update, the reverse-case probe, canonical response IDs, and
canonical audit workspace IDs. At `73a4434`, all 23 affected workspace-route/service, personal
connection, and secret-box tests passed, together with API typecheck/build and repository lint.
The branch now defines 332 unit/integration cases; a full 332-case rerun was not performed after this
three-file fix because the affected checks cover it and the preceding 331-case/full-browser gate
already passed. The Web implementation did not change during the fix.

**Both independent review axes are clean at `73a4434`.** Spec reviewed all six acceptance criteria,
scope/projection/admission behavior, repository authority/audit/revisions, Web flows, real API/client
and protocol tests, and the mixed-case UUID delta; no additional findings and no redundant suite run.
The original Standards reviewer rechecked the fix with 12 independent workspace-route and personal
connection tests and direct encryption checks, confirming historical personal AAD compatibility.

## Combined integration

Integrated as `3c515b6eabbd1f0e60fed53b58c69f979556d1f6`: all 400 unit/integration tests (77 API unit,
19 Web unit, 161 API integration, 143 Web integration), 10 ordinary browser scenarios and one real
signed-IdP journey passed, with formatting, types, both production builds, workflow YAML and all 22
embedded shell steps. The root integration preserves migration0007 before0008 and all earlier
member/OIDC/provider fixes. Root independently reviewed the exact shared-connection table and column
Compose privilege assertions. Actual PostgreSQL/Compose evidence remains `PROV-02-E1` in REL-01.

## External gates and integration seams

Actual PostgreSQL and Compose remain external gates on the integrated PROV-02 revision. Local
`pnpm --filter @openbot/api test:postgres` discovered ten gated tests and skipped them because no
PostgreSQL test URLs are configured; neither PostgreSQL nor Docker is installed here. The provider
runtime suite includes workspace restricted-role create/update/use/disable behavior, cross-admin
encryption, stale revision rejection, audit-failure rollback for create and disable, denied
workspace reassignment/deletion, and a request blocked behind a workspace lock that must observe
committed member removal before probing. These definitions are not claimed as executed PostgreSQL
evidence. Require the integrated `postgres-providers`, `postgres-auth`, and Compose CI results
before closing the external gate.

Root now has AUTH-02 migration 0007; merge it before this unpublished 0008 and preserve both runtime
grant additions, migration snapshots, and ordered Compose ledger. The historical 0006 backfill test
currently removes subsequent 0008 schema before replay; preserve AUTH-02's 0007 fixture changes when
merging. Root has a later COL-01 historical-migration construction seam planned to replace this
teardown, so this ticket does not duplicate that refactor. Keep the root API maxWorkers=4 fix.

Implementation commits: scoped storage 957aab7; API/admission 667f256; Web client 5544993 (child 73edeca);
real HTTP BFF 2940aa7; HTTP role grants 25bfe76; admission deadlines 36b804e; Web UI/browser fb4d6ae
(child abd1186); UUID review fix 73a4434. Root owns PROGRESS, index, release-gate closure, and integration.

## External gate closure

PROV-02-E1 closed by [Verify33943840316](https://github.com/Blackman99/openbot/actions/runs/33943840316), all five jobs successful on remote `3f4e39145b4b3af53ed49c182eacaadb0144740c`, completed on 2026-09-05 at 04:12:53 UTC. The restricted provider suite passed three actual tests, including the new shared connection lifecycle, cross-admin credentials, rollback and workspace-lock revocation admission. Authentication/OIDC and Compose checks passed on the same revision. Earlier local skip records are historical; final REL-01 acceptance still applies to the final combined revision.
