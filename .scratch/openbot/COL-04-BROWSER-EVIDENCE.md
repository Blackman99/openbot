# COL-04 browser evidence

Isolated branch `ticket/col-04-browser` starts at `0df74139752a4a91233b4177a39b1cff8d063b2a`, the Web checkpoint merged with the actual core/BOT-06 chain. Browser source candidate: `30a48fbfbbfbc0148ddfb3da8adfdcb6c01c3c21`, tree `bef4002b3fd5eb9c2c41cd44f2ac7dc027d583de`.

This is authored UI evidence for independent review, not ticket approval or actual worker/PostgreSQL execution proof.

## Scope and journeys

The new `task-fixture.mjs` provides safe persisted Task/Run DTOs, explicit group grants, current conversation access, submission receipts, and controlled status changes. It records submitted commands and keeps one human prompt per accepted command. The existing conversation fixture supplies shared history projection through two scoped Task helpers; Bot output gets the additive author discriminator and no human edit/delete/audit controls. Fixture registration and reset are additive.

Three new Chromium journeys in `tasks.spec.ts` cover:

1. A direct task submits one prompt, shows one queued attempt, and reloads saved running/completed status. It displays the actual protocol/model and cumulative usage snapshots, including zero output tokens, then follows the final response link. The original prompt and pinned Bot/version output remain after reload; human controls remain available only on the human message. No ordinary-message endpoint is called as a separate write.
2. A group member with no direct Bot inspection access explicitly selects the active grant; the closed grant is absent. An unavailable response after commit preserves the exact key, whitespace, and grant, freezes those values, and replays to the same Task/Run without another prompt. Saved running/failed reads retain actual provider/model and safe failure text without a fabricated Bot response. Revocation rejects a later submission and reload while preserving the draft and session cookie; identity remains valid. The page makes no protected Bot configuration lookup, and a direct Bot API probe returns 403.
3. A key already committed with different content produces conflict feedback and blocks resubmission. Explicit refresh supplies a new usable command. The browser then aborts delivery of a new submission response after its upstream action completes; unchanged replay reaches the same second Task and retains exactly the two deliberately submitted human prompts.

The journeys inspect rendered pages for secret/configuration field leakage and exclude Task retry/cancel controls. They use intentional refreshes and reloads, with no SSE or polling added.

## Witnessed browser RED → GREEN

On `0df7413`, the direct journey failed after the fixture saved completion: clicking the visible **Refresh task** link kept **Running** and its old 12/0 usage snapshot. The list journey independently failed after a conflict: clicking **Refresh tasks** on the same URL kept the old idempotency key and blocked a new deliberate command. Both failed ordinary browser assertions after five seconds; neither was a fixture startup/parser error. The group replay/failure/revocation journey already passed.

These production findings were sent to root before any product edit. Root supplied `c891fdfaf97cbda31d0881228fc582e097a3f745`, changing only the two explicit refresh links to use `data-sveltekit-reload`. It was cherry-picked unchanged here as `488c42f0027bfabdfd06204ed30b71e8510af861`. The original status/usage and new-command assertions were retained; the direct journey also independently checks that the fixture has persisted completion before clicking refresh.

After that fix, all three Task journeys and five existing shared-fixture regressions passed together. No other production Web, API, worker, schema, or contract changes were authored in this worktree.

## Local verification on 2026-09-05

| Check                                           | Actual result                                                                                |
| ----------------------------------------------- | -------------------------------------------------------------------------------------------- |
| Web sync/typecheck                              | Zero errors and zero warnings after the fixture/test changes and after the root refresh fix. |
| MJS syntax                                      | `node --check` passed for the Task fixture, conversation fixture, and fixture API.           |
| Focused formatting and diff checks              | Passed.                                                                                      |
| Chromium: Task + conversation + group-Bot files | Eight passed in 47.8 seconds: three new Task, three conversation, two group-Bot journeys.    |

The exact browser command from `apps/web` was `pnpm_config_verify_deps_before_run=false ./node_modules/.bin/playwright test tests/e2e/tasks.spec.ts tests/e2e/conversations.spec.ts tests/e2e/group-bots.spec.ts`. Builds and Web typechecks ran sequentially. The existing Playwright configuration performed its normal production build and server startup. The environment setting preserved the shared installed dependencies; no dependency install or checked-in package/configuration change was needed.

Logs: `/tmp/openbot-col04-browser-direct.log`, `/tmp/openbot-col04-browser-replay-red.log`, and `/tmp/openbot-col04-browser-focused.log`. After the successful run, TCP checks returned `ECONNREFUSED` for both 4399 and 4173, and the browser lease was explicitly released to root.

## Remaining gates

The fixture stores records in its own process and advances states through explicit test controls. Browser reload success demonstrates the Web consuming saved API state; it does not prove durable queue claims, provider execution, database restart persistence, transaction rollback, actual runtime privileges, or physical infrastructure behavior. No PostgreSQL, Docker, native worker, OIDC, or full repository gate was run for this bounded helper task. Root owns independent review, combined verification, integration, publication, and the separate native evidence gate.
