# COL-02 verification and integration handoff

Ticket: `19-col-02-add-bot-membership-and-history-grants.md` (all seven acceptance criteria).
Base: `9ce77fd523ab604f11cc30e699677e1c95b40e7c`.
API core: `9163b5037aab7b701c7589ce26ceae1fae0d7d32`.
Full production candidate: `efe3eb76705d69e9b47fb9e2fd8cfbfaaa864fd7`.
Native-test syntax correction: `7f0f86f99e366eb179630104d1dd593d2462a3af` (one missing SQL `END;` terminator; production unchanged).
Final browser fixture correction: `3a297f9a94e33aaf5830a1cb17a77d6edee103ad` (workspace membership provenance seeded for group navigation; production unchanged).

## Behavior and seams

The API and Web expose current group Bot membership, all four history choices, fixed-grant removal, durable closure and a read-only allowed-context preview. Every grant records its original grantor, join event, inclusive lower sequence and any permanent closure. The ninth active Bot and active duplicates fail with stable 409 codes. Closed grants remain visible and a replacement never inherits the old history boundary. A temporary model outage does not release a seat.

Context admission uses `GroupBotTransaction.lock(existingSqlConnection, access)`, which retains a private canonical group/grant identity. Its `context(read)` filters original message creation before current edit/tombstone projection. The transaction must remain open through dependent operations. This seam grants no direct Bot configuration/avatar/provider access and contains no Task/Run execution. Provider authorization remains the actual requesting human's responsibility.

Both existing revocation entry points prepare typed `GroupBotRevocations` under workspace → sorted affected groups → Bots → conversations, then perform their own fresh final mutation authorization. A batch can close only the pinned grants and append their typed closure events/audits. The actual revoker is the event actor; original grantor provenance stays separate. Restoring workspace/Bot access does not reopen a grant. Group role demotion alone does not close it. No administrator gains group-content admission through revocation.

Migration `0015_group_bot_grants` adds typed membership events to the existing ledger and retained grants; it does not duplicate counters or amend published 0014. Only the private typed event writer allocates sequences, always with its event and required audit. PostgreSQL guards protect grant identity/history, join/closure event provenance and irreversible closure. Runtime can SELECT/INSERT and UPDATE only `close_event_id`, `close_sequence`, `closed_at`, `closure_reason`; it cannot delete/truncate grants or directly execute guard functions.

## Local red → green and focused evidence

- Default invitation/replay/list: actual API 404 before implementation → one durable grant, join event and safe audit; the same command returns the retained grant.
- Context: missing route 404 → original-creation eligibility, late edits still excluded, current tombstones visible only for eligible originals.
- Explicit all/since-event/since-time: rejected 400 → persisted resolved bounds, cursor continuation after service reconstruction.
- Removal/reinvitation: missing route 404 → pinned closure, repeated removal, new grant excludes the absence interval; explicit all history can widen access.
- Duplicate/ninth seat: unclassified 503 → specific `group_bot_already_active` / `group_bot_limit` 409, no sequence/audit mutation on rejection.
- Bot ACL and workspace removal: retained grant incorrectly remained open → both actual DELETE API flows permanently close it, attribute the actual revoker, preserve grantor provenance, deny revoker group history and require explicit reinvitation after restored access.
- Mandatory native guard installation: migration incorrectly resolved → installation failure rolls back and does not record 0015.
- Malformed JSON: incorrectly mapped 503 → safe 400 without parser diagnostics.
- Strict client body budget: a valid 40 × 32k context response exceeded the original 1 MiB cap → accepted under a bounded 32 MiB successful-response budget; errors remain 1 MiB and over-limit valid JSON is rejected.

Fixture corrections were not counted as feature RED evidence: the removal test initially used a command key containing spaces; after correcting it, temporarily omitting only the removal route reproduced the intended 404 RED before restoring the implementation. The disabled-model fixture was corrected to use the existing provider service rather than a nonexistent SQL column. The group-role regression used the wrong service method name once and was corrected. The first browser run had one fixture failure: seeded workspace members lacked `joinedAt`/`invitation`, so the existing strict member client correctly rejected group navigation. Seeding those fields through the existing fixture helper made both journeys pass without production changes. Native test assembly initially placed two cases outside their skipped describe scope; typecheck caught this before any verification claim, and all 14 cases now register inside the native suite.

The frozen API core passed API typecheck and 42 focused tests: 12 group Bot API, 1 migration-failure definition, 14 conversation, 15 Bot ACL. The group suite includes an actual Fastify HTTP server consumed by the strict Web client for canonical UUID paths, invite replay/payload conflict, context and fixed-grant removal. It also verifies ordinary group members and group managers without direct Bot rights cannot inspect/configure avatars or acquire Bot Editor permission.

UI helper evidence is authored implementation evidence, not independent review: Web 45 unit + 388 integration tests, typecheck, formatting and build passed. Browser scenarios use an isolated UI seam fixture; they do not claim PostgreSQL persistence, locking or runtime-role proof.

## Full local gates

Passed on frozen production candidate efe3eb7:

- `pnpm lint`.
- `pnpm typecheck`: API and Web; Svelte 0 errors / 0 warnings.
- `pnpm test:unit`: API 88 + Web 45 = 133.
- `pnpm test:integration`: API 288 + Web 388 = 676.
- `pnpm build`: API and Web production builds.

Total: **809 unit/integration tests**. The two focused Chromium journeys passed via `pnpm --filter @openbot/web exec playwright test tests/e2e/group-bots.spec.ts`; `pnpm test:e2e` subsequently passed **23 ordinary Chromium scenarios + 1 signed OIDC scenario**. Both ports 4399/4173 returned TCP ECONNREFUSED after completion and the lease was explicitly released. These staged commands cover the corresponding `pnpm verify` phases; root approved avoiding a redundant broad rerun solely to concatenate equivalent commands. The later one-line native SQL test correction changes no locally executed production/test behavior.

## Independent review

- **Standards CLEAN** — independent `/root/col02_core_standards`: core 9163b50 inspected and independently ran 44 tests across five files (`group-bots`, `group-bot-migrations`, `conversations`, `bot-acl`, `bot-acl-http`). Final efe3eb7 Web/native-14/CI delta clean, with API and runtime grant script unchanged. The one-line native SQL correction 7f0f86f and browser fixture/navigation delta 3a297f9 were each rechecked clean. No native/browser/full-suite execution claimed by this reviewer.
- **Spec/intent CLEAN** — independent `/root/col02_spec_review`: all seven ACs at efe3eb7 inspected, including native definitions, Web and browser assertions; independently ran 13 API/migration tests. Both 7f0f86f and 3a297f9 deltas rechecked clean with ACs and production behavior unchanged. No native/browser/full-suite execution claimed by this reviewer.

Both independent axes are clean at final source/test pin **3a297f9a94e33aaf5830a1cb17a77d6edee103ad**. Final evidence/ticket changes are documentation only.

## COL-02-E1: external PostgreSQL / Compose gate

Status: **pending actual CI execution**. There is no local PostgreSQL/Docker service; provisioning was not attempted. `pnpm --filter @openbot/api exec vitest run tests/postgres/group-bots-runtime.test.ts --maxWorkers=4` registers **14 skipped** cases locally, not 14 successes.

The dedicated `postgres-group-bots` CI job starts disposable PostgreSQL 17.11, migrates the real schema and provisions the actual fixed `openbot_runtime` role. It has its own server, so password rotation cannot race another native job. Its 14 cases define:

1. Exact runtime grants, owner-level immutable/retention guards, join/closure provenance and reopening rejection.
2. Nine concurrent invitations produce exactly eight grants/events/audits and one limit rejection.
3. Concurrent identical retry collapse and duplicate-active rejection.
4. Audit failure rolls back new conversation, grant, event and counter.
5–6. Bot ACL / workspace removal final-audit failure rolls back the parent revocation and all closure work.
7–8. Both revocation paths close grants across groups with actual actor provenance, no implied content rights, and no reopening after access restoration.
9. Borrowed context holds current authority until caller completion; a dependent SQL failure rolls back before waiting removal completes.
10. A waiting context read rechecks workspace membership after the winning removal commits.
11. Original creation eligibility, late edits, tombstones and explicit wider history through restartable cursor continuation.
12. Revocation waits for group locks before acquiring a Bot lock.
13–14. Invitation/revocation in both observed lock orderings: successful invitation is subsequently closed, or revocation wins and the waiting invitation cannot persist.

Compose additionally checks migration order through 0015, exact grant table privileges and the four permitted closure UPDATE columns. Existing database/Compose jobs and BOT ACL grant expectations are preserved. Root owns publication, integration and external gate closure; local checks cannot close COL-02-E1.

## Dedicated integration

Accepted28ce290e994f769219eb16b17565eb589dc12e16, tree1cdf7746ad50b61500a3b9ccc657ebbc066f84b9. Full pnpm verify passed867 code tests and27 browser scenarios, formatting/types/builds. Root reviewed the four additive shared paths;34 candidate paths match. No behavior correction. Actual14 native cases and0015 Compose remain COL-02-E1.
