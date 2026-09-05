# BOT-01 verification and integration handoff

## Implemented contract

Bot creation is private. It writes a stable Bot, immutable version 1, non-null current-version pointer, sole creator owner grant, and `bot.created` audit in one transaction. Identity configuration keeps `roleDescription` separate from the independent Bot access role. Name, role, description, instructions, model binding and execution limits follow BOT-CONTRACT; execution itself remains outside this ticket.

Every list/detail admission checks current workspace membership. Explicit Bot owner/editor/user roles are independent of workspace roles; workspace administration does not bypass a private Bot. Workspace-visible metadata is discoverable without an explicit Bot grant, but configuration, instructions and binding identifiers require an explicit grant. Workspace removal immediately denies all admission while retaining historical authors and grants; rejoining reactivates a retained grant.

The immutable version stores only the explicit provider scope, connection ID and selected model ID. `bindingStatus` is fresh and viewer-specific: disabled, changed model, insufficient Basic capability, or inaccessible/deleted provider produces an unavailable status. Provider credential rotation does not invalidate an unchanged usable model. No fallback or model substitution occurs. Ready Basic-only bindings are labeled chat-only; enabling current collaboration capability updates that label without rewriting version 1.

## Test-first evidence

- The initial creation request returned 404 before the persistent Bot/API tracer existed; creation, defaults, sole owner, pointer and exact safe audit then passed.
- Invalid identity fields/limits and inaccessible model bindings initially returned storage errors; bounded parser and model admission mapping produced safe validation responses.
- List/detail initially returned 404; explicit ACL and workspace-discovery behavior then passed.
- An uppercase scope/connection request returned 400 before UUID canonicalization; canonical response, stored configuration and audit assertions then passed.
- The transaction permission seam initially did not exist; the owner/editor/user/discovery permission matrix, workspace removal and retained-grant rejoin then passed.
- Creation initially used request time; an injected admission-time clock regression failed before timestamp sampling moved after model admission.
- An injected mandatory audit failure initially returned 500; the HTTP boundary now returns a fixed 503 `bot_unavailable` without SQL or credential details. Atomic database rollback is proved separately by the native suite.
- Explicit null description initially created a Bot; it now fails validation, while omitted description defaults to empty.
- Failed native constraint installation initially marked migration0012 applied; the migrator regression now rolls back without recording the version.
- The maximum supported model identifier is 256 characters, matching the provider parser's effective trimmed bound. A real provider-to-Bot regression accepts 256 and rejects 257. An initial source-review concern about the provider's earlier 2048 raw-string guard was disproved by its later 256 guard and an actual provider-save test; no speculative bound change remains.
- Real HTTP `BotApiClient` create/list/detail and safe rejection tests cross Fastify with cookie, Origin and canonical UUID contracts. The shared deadline regression uses a real server that sends headers and stalls the JSON body.

## Local verification

At API checkpoint `f42e675`, repository formatting and both typechecks passed with zero errors/warnings. The 567 unit/integration tests passed: API 77 unit + 216 integration; Web 27 unit + 247 integration. This checkpoint includes the client but precedes final Bot pages/native-test merge. Final combined counts, browser journeys and independent review pins follow below.

At combined candidate `cdeff01f87a0c4aaa9a102afaa6c9e576b7b7e24`, repository formatting and both typechecks passed with zero errors/warnings. All 594 unit/integration tests passed: API 77 unit + 217 integration; Web 30 unit + 270 integration. The four commands ran sequentially and returned exit code 0. The remaining `pnpm test:e2e && pnpm build` then returned exit code 0: all 15 ordinary browser journeys passed in 46.8 seconds, the real signed-OIDC journey passed in 23.5 seconds, and both production builds passed. This completes all six `pnpm verify` constituents in order. Ports 4399 and 4173 were independently confirmed closed and released afterward.

Workflow YAML and all 26 shell steps passed syntax checks after the dedicated Bot job and narrow Compose assertions were added. These checks are syntax evidence, not a PostgreSQL or Docker execution claim.

## Independent review

- STANDARDS: clean on final candidate `cdeff01f87a0c4aaa9a102afaa6c9e576b7b7e24`. The core review at `0fd83b8` independently ran 16 API lifecycle/deadline cases and 16 strict client cases. Final UI review independently passed 42 Web client/route/render cases. No findings remained.
- SPEC: clean on the same final candidate, covering all six acceptance criteria and approved authority/model-binding contracts. Independent runs passed 11 core API cases, 16 core client cases, and 42 final Web cases. No findings remained.
- Reviewers did not run shared Svelte generation, browsers, or native PostgreSQL. Their source/test reviews do not close BOT-01-E1.

## Native PostgreSQL gate: BOT-01-E1

`TEST_BOT_DATABASE_URL` must target the dedicated disposable PostgreSQL server/database from `postgres-bots`. The suite invokes the actual deployed role provisioner, which configures the fixed `openbot_runtime` role; sharing its server with other provisioner suites would race passwords and grants.

```sh
pnpm --filter @openbot/api exec vitest run tests/postgres/bots-runtime.test.ts
```

The local explicit test command discovered eight cases and skipped them because `TEST_BOT_DATABASE_URL` is absent. No native PostgreSQL execution is claimed. Required native evidence covers the deferred same-Bot pointer constraint at COMMIT, immutable version UPDATE/DELETE/TRUNCATE rejection, exact deployed privileges, mandatory audit rollback, both commit orderings for model disable and workspace removal, and a creation timestamp sampled after actual provider admission. Actual PostgreSQL locks are observed through `pg_stat_activity` and `pg_blocking_pids`; pg-mem does not substitute for this evidence.

Migration0012 installs `bots_current_version_same_bot`, a deferred composite FK from `(bots.id,current_version_id)` to `(bot_versions.bot_id,id)`. The statement-level immutable-version trigger also rejects truncation. The default production migrator installs both; pg-mem fixtures explicitly omit native guards. The Compose ledger assertion now ends with `0012_bot_identity` after published0011.

| Relation | SELECT | INSERT | table UPDATE | DELETE | TRUNCATE | column UPDATE |
|---|---|---|---|---|---|---|
| bots | true | true | false | false | false | current_version_id only |
| bot_versions | true | true | false | false | false | none |
| bot_acl | true | true | false | false | false | none |
| audit_events | false | true | false | false | false | none |

The runtime role cannot execute `reject_bot_version_mutation()` directly. The one Bot column UPDATE grant permits the row lock used by current admission and the future append seam. No visibility or ACL mutation grants are introduced before their ticket.

The dedicated restricted-role suite proves Bot runtime behavior; the existing Compose check only adds ordered-ledger and exact Bot privileges. No extra upstream-provider or large Compose Bot fixture is required. BOT-01-E1 remains open until actual CI passes.

## Seams for the next tickets

- `apps/api/src/bots/postgres-bot-access.ts`: `lockAuthorizedBot(connection, { actorUserId, workspaceId, botId }, permission)` checks fresh workspace membership and independent Bot permissions while acquiring workspace then Bot locks. The caller owns the transaction and its atomic audit. Permissions are discover, inspect, use, edit, manageAcl and manageLifecycle.
- `apps/api/src/bots/model-binding.ts`: `admitBotModel` reuses PROV-05 transaction-scoped admission. It acquires the provider scope lock after the Bot/workspace locks; use this only when a new or explicitly changed/restored binding requires admission.
- `apps/api/src/bots/schema.ts`: version identity/number/author/time remain server-owned, with unique `(bot_id,version)` and `(bot_id,id)`. A future version append must create a fresh version ID and audit in the same transaction; no pointer rewind or version UPDATE.
- Fresh `bindingStatus` is a read projection, never a durable grant or version field. Historical identity reads remain available even when the provider becomes unavailable.
