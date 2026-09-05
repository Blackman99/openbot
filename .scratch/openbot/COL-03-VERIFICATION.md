# COL-03 verification and integration handoff

## Implemented behavior

One persistent conversation exists per group, and one direct Bot thread per workspace/Bot/human creator. Direct history intersects creator privacy, current workspace membership and Bot inspect permission; writes use current Bot use permission. Bot owners and workspace administrators cannot read someone else's private direct thread. Provider availability is independent of authorized historical reads. Group content requires current explicit group membership, including for workspace administrators.

Each typed human command locks workspace, group/Bot and conversation in that order. The conversation counter, immutable event, actor-scoped idempotency key/hash and mandatory safe mutation audit commit in one transaction. Replays reauthorize and compare typed operation, canonical target, version precondition and normalized payload before returning the original receipt. Replay precedes CAS. Borrowed admission snapshots canonical actor identity so later caller-object changes cannot change attribution.

Author edits append complete versions. A group owner/admin can tombstone another author's message only with a reason; authors can delete their own messages. Tombstones do not erase originals, cannot be undone, and hide bodies from ordinary projection. Full chains require current author/group moderator authority, or the direct creator. Projections include only safe message/actor details and current allowed actions; audit metadata contains references rather than duplicate message bodies.

Pagination orders by immutable creation sequence and fixes a creation horizon. Each page resolves the current edit/tombstone, including changes after the horizon, and omits new creations after the horizon. Cursors survive a new service instance without process memory. Original creation eligibility is selected before projection, preserving the later Bot history-grant boundary.

## Test-first evidence

- Group open/append initially returned404; the first persistent tracer now stores one event and audit across repeated requests.
- Borrowed append initially returned only a receipt; the consumer regression became green when it exposed `{receipt,replayed}` inside the caller's transaction.
- Current reads and edits initially returned404. Direct opening initially returned400. Each became green with its public contract before the next slice.
- Moderation initially returned404. The final tests distinguish author editing from moderator tombstones, require reasons, keep original events unchanged and deny ordinary audit-chain access and undelete.
- Cursor reads initially returned400. Restarting the service between pages now preserves creation ordering while showing later edits and tombstones.
- A borrowed caller could initially mutate the admitted actor object and change event attribution. A red regression now proves the canonical actor is captured before admission.
- Independent Standards review found that mutable public metadata could redirect an admitted transaction into another workspace. Both direct metadata and `read().conversation` alias regressions first failed by incrementing the other conversation's counter. All reads, writes and audit scopes now use private frozen canonical admission IDs. Public metadata/subjects are frozen detached snapshots, including a fresh Date. Both regressions verify the original counter, reads, version-chain access and audit scope remain admitted while the private conversation stays unchanged.
- The migration initially recorded success despite the missing ledger guard. The installation-failure regression now proves rollback without recording0014 when native guard installation fails.
- Additional boundary regressions cover idempotency payload409, actor-scoped keys, no workspace-admin bypass, immediate revocation, bounded fields, server-owned metadata, session/Origin, and masked unexpected database errors.
- The strict Web client independently crosses a real listening Fastify server for open, replay, current pagination, edit, conflict, tombstone and full chain. Its GET calls have no body Content-Type; the separate Web client tests cover deadlines through stalled JSON bodies.

## Local gates

The complete non-browser command at final source `a33a4e83a7fada8607d84f270cd10aecddf7f76f` passed645 cases: API77 unit +232 integration; Web35 unit +301 integration. Repository formatting and both typechecks passed, with zero Svelte errors/warnings. These counts include the metadata fix, strict Web client and all conversation pages. Both production builds passed. The earlier core-only run at3544eca passed623 cases before the two metadata and20 page regressions.

```sh
pnpm lint && pnpm typecheck && pnpm test:unit && pnpm test:integration && pnpm build
```

The UI has explicit POST opening for accessible groups/Bots, current-message rendering, permission-driven controls, stable command keys and retained drafts/preconditions across failures, visible conflict handling, separate authorized version pages, and opaque pagination.

The UI helper passed the three new Chromium journeys, then the full18 ordinary scenarios plus one signed OIDC journey, with serial production builds. The browser fixture/spec commit `ebf4f907875ec0eb97ff0f9c08835b9d51502a96` was cherry-picked as final candidate `e599f4ca96474a47c59dfe140bb9e29f2b7547fa`; production UI source63840bcc was unchanged during this browser gate. An initial focused attempt failed because a fixture Bot had an empty roleDescription rejected by the existing strict decoder; correcting that fixture produced the green run without a production change. Both leased ports were released and confirmed closed afterward.

These journeys prove stable-key/draft retention after an already-committed503, stale edit precondition preservation, author/moderator tombstones and separately protected version pages, creation-horizon/current-content navigation, direct creator privacy despite model unavailability, and revocation403 without clearing a valid identity cookie. Their isolated in-memory UI seam does not prove PostgreSQL persistence, transaction isolation or deployed grants; real Fastify/client and native gates are distinct.

Workflow YAML parses, and all28 shell steps pass `bash -n`. This is syntax evidence only. No local PostgreSQL/Docker provisioning attempt was made.

After the Standards metadata finding, the affected conversation/migration/group suites passed26 cases (including both new regressions), and API typecheck passed. The later645-case combined run verifies the fix with the final UI source.

## Native gate COL-03-E1

`TEST_CONVERSATION_DATABASE_URL` targets the dedicated disposable database/server in the new `postgres-conversations` CI job. The test invokes the actual deployed runtime-role provisioner, so it must not share a server with another password/grant-changing native suite.

```sh
pnpm --filter @openbot/api exec vitest run tests/postgres/conversations-runtime.test.ts
```

This command discovered10 cases and skipped all10 locally because the URL is absent. Typechecking passed. These skips do not prove locks, rollback, triggers or deployed privileges. COL-03-E1 remains open until the actual PostgreSQL job and Compose gate pass on the integrated revision.

The native cases cover exact SELECT/INSERT-only table grants plus the counter-only UPDATE grant; denied historical UPDATE/DELETE/TRUNCATE even for the table owner; immutable subject/counter guards; same-workspace subject foreign keys; concurrent identical command collapse;12-way ordered appends; competing payloads and edit CAS; actual audit privilege failure rollback without burning a key; rollback of a dependent operation in the borrowed transaction; group/workspace revocation while an actor waits; the opposite commit ordering and later replay denial; and timestamps sampled after a measured lock wait. Waiting assertions observe `pg_stat_activity`/`pg_blocking_pids`, not sleeps or pg-mem claims.

Migration0014 is provisional. It adds no changes to published0012. The merger may renumber only unpublished migrations or insert the separately completed BOT-02 migration before this one, preserving the actual published ledger. Composite subject references prevent cross-workspace group/Bot associations; restrictive foreign keys and append-only triggers prevent historical events from disappearing through parent deletion.

| Relation | SELECT | INSERT | table UPDATE | DELETE | TRUNCATE | column UPDATE |
|---|---|---|---|---|---|---|
| conversations | true | true | false | false | false | last_sequence only |
| conversation_events | true | true | false | false | false | none |
| audit_events | false | true | false | false | false | none |

Runtime cannot execute the two guard functions directly. Compose checks the exact ledger and privileges; the dedicated native job exercises behavior. No model transport, Task execution, SSE or COL-02 grants are introduced.

## Downstream transaction seam

The exact HTTP/DTO and UI contract is [COL-03-API-CONTRACT](COL-03-API-CONTRACT.md). `ConversationTransaction.lock(existingConnection, access, now?, permission?)` borrows the transaction, rechecks current scope authority and retains the established lock ordering. `append`, `edit` and `tombstone` return `{receipt,replayed}`; the public API exposes the stable receipt only. The caller must keep the same connection until all dependent writes and audits commit or roll back, and must not reuse an admission after transaction completion.

Coordinator decision: retain NOT NULL message identity/version and the private allocator in COL-03. COL-02 will add an additive migration and a typed membership append method that allocates, writes its event and audits in the same admission/transaction. It will reuse the internal counter rather than expose an allocate-only operation or duplicate the ledger. No general arbitrary-event endpoint is provided.

COL-04 can append its trigger and create a Task/Run in the same borrowed transaction, resolving its persisted receipt on replay. Additional Bot/group admission must respect workspace → group → Bot → conversation ordering. Current identity/provider configuration is never copied into conversation storage. Future MEM/RET consumers can retain workspace/conversation/message/version-event references and reauthorize source content before using it.

## Review and UI status

Both independent axes are clean at final source `e599f4ca96474a47c59dfe140bb9e29f2b7547fa`, against base `47553b1e5331aeaa869d44e96537b38d53d9fd2b`.

The original Standards core review at3544eca found the metadata admission P2 described above and independently passed24 API +16 Web cases. The final independent Standards reviewer inspected the complete API/schema/grants/CI/BFF/pages and browser delta, closed that P2 after fix `a152490738aa714d73a58039c25330b5a3203215`, and independently passed62 focused cases:26 API conversation/group/migration plus36 Web client/routes/render. Both direct metadata and read-alias regressions passed. No unresolved P0–P3 findings remain.

Independent Spec source review was clean at `a33a4e83a7fada8607d84f270cd10aecddf7f76f`, covering all six AC, current group/direct authority, the borrowed fix and API/BFF/UI. That reviewer independently passed51 focused cases:15 API conversation/migration (including real Fastify/client HTTP) and36 Web client/routes/render. The final Spec affected review is clean at e599f4c, including all three browser fixture/spec files. Neither final reviewer claimed a browser, native or redundant full-suite rerun.

The UI author's source63840bcc was integrated as a33a4e83 and browser deltaebf4f907 as e599f4c. The final documentation commit changes no reviewed production/test source. Neither these notes nor a browser fixture substitutes for actual API/native evidence.

Integration must preserve the root's later BOT-04 runtime grants (`bots.visibility`, `bot_acl.role` and ACL DELETE), its updated exact Compose assertions and serial Bot ACL native command, along with BOT-02 migration0013. This ticket adds only its ledger grants/guards/job; it must not replace the newer root baseline with the older base version. Root owns integration, actual CI execution, global metadata and COL-03-E1 closure.

## Dedicated integrated gate

COL-03 integrated as `d559da23b4ae19429304f3a124f93f187025df42`, tree `26dc19629b52d56076128aeb7b64538a7fb6c396`. Both independent review axes are CLEAN at source `e599f4ca96474a47c59dfe140bb9e29f2b7547fa`; final author `3a3511e342978dfe9f607d33a77062202e6fd7e7` adds only evidence. Dedicated integrated full `pnpm verify` exited0:755 unit/integration tests (API88unit+275integration, Web40unit+352integration),21 ordinary browsers and one signed-OIDC journey,formatting/types/builds. Root independently reviewed the seven-file additive integration delta; conversation core/source tests match the reviewed candidate exactly. YAML/36 Bash steps/two embedded JS/three MJS syntax checks passed. Native PostgreSQL ten cases and actual Compose remain the explicit COL-03-E1 release gate.

Log: `/tmp/openbot-col-03-integrated-verify.log`. Both4399/4173 were confirmed closed after completion; root and browser leases released.
