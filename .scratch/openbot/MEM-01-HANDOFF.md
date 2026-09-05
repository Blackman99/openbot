# MEM-01 implementation candidate

Original ticket: [37-mem-01](issues/37-mem-01-save-a-group-message-as-scoped-memory-and-use-it-in-the-next-answ.md). Its six acceptance criteria are unchanged and remain subject to root acceptance. The final reviewed source is `19568c9fc603b97213cd5560a097471ba93107fa`, tree `0f33d9b41358f50a67ebafc0c5f0e6a43fe625d1`. It incorporates accepted ATT `0bbaf8562fc2727cc5c563f1f3a1555cdd910779` and the complete COL-05 candidate `9425c6647869668bc6de9112349d69219cd40131` under root authorization. Incorporation does not itself accept COL-05 or close its external gates. The actual 0020 schema/selector/manifest prerequisite was handed to root at `0817543edd06faf8f37e90b961d9bc8e7910897b`; the complete candidate retains actual 0019 followed by actual 0020.

## Behavior and acceptance mapping

| Original criterion                                              | Implementation and focused evidence                                                                                                                                                                    |
| --------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Group member saves a visible message through UI and REST        | `memories/routes.ts` and `service.ts`; conversation save form; `memories.test.ts`, `memory-routes.test.ts`, `memory-pages.test.ts`; actual browser `memories.spec.ts` passed                           |
| Source event, creator, time, confidence, scope, initial version | Immutable metadata and v1 source locators in `memories/schema.ts`; exact source projection/parser; `memory-source.test.ts`, `memories.test.ts`, input validation and native provenance tests           |
| Subsequent same-group Bot Run receives authorized memory        | Identified `group_memories` contribution and append-only Run locators at successful claim; `memory-context.test.ts`, `memory-worker.test.ts`, aggregate limit tests and native claim/publication tests |
| Other group/Workspace Bot cannot list, search or receive it     | Exact group/Workspace/grant selector before LIMIT; `memory-access.test.ts` and `memory-context-isolation.test.ts` exercise REST and actual provider boundaries                                         |
| History-excluded source also excludes derived memory            | Original creation sequence, exact current grant and current human/grantor admission at claim and publication; late-edit/future-only/replacement tests in access/context/native suites                  |
| Unauthorized create/read returns audited content-free 403       | The REST service commits the denied outcome audit before throwing; audit failure is 503; integration and native rollback tests cover denied create/read/search plus wrong Origin                       |

## Intentional boundaries

Version 1 retains no copied source body. It references one current human or Bot text source, including its original creation event/sequence and exact revision event. A later source edit, tombstone, or pending/completed attachment purge immediately excludes the memory from ordinary reads, search and model context, including reads by the source author or administrator. A stale replay never recreates the memory. System events and private direct conversations are ineligible.

Confidence is a finite human estimate in `[0,1]`, initially shown as `0.5`; it is not a model-derived certainty. Search text travels in a POST body and uses literal, case-insensitive SQL matching. Pagination uses bounded UUID cursors after source eligibility. Native PostgreSQL owns the wildcard-escape proof because pg-mem does not implement PostgreSQL's ILIKE escape semantics.

The claim keeps the Task trigger last. Memory items/bytes share the existing 1,000-item/1-MiB context budget, and at most 100 memories may be selected. The manifest contains only the version/source event locators actually selected for that claim. Fresh admission and current-source checks run before every later delta and terminal output; memories saved after claim do not silently join the manifest. Already legitimately transmitted bytes cannot be recalled.

MEM-04 must intentionally extend immutable versions, forget/revoke, or explicitly retained independent content. RET-01 may replace retrieval/ranking/budgets through the current scoped selector and sent-locator manifest. Neither extension may accidentally reintroduce old source versions into ordinary read/context paths. Attachment purge remains limited to attachment-bearing human messages; Task source identity guards are unchanged.

## Verification status

Witnessed RED/GREEN evidence is summarized in [MEM-01-CORE-CHECKPOINT](MEM-01-CORE-CHECKPOINT.md): missing point selector; 404 REST create/read; missing identified provider contribution; source edit still publishing stale final output; UI missing save affordance. The corresponding source, REST, provider and rendered UI tests passed after implementation. The streamed overlap case preserves the first legitimate delta and blocks subsequent stale bytes and final output.

Final results on the reviewed source tree, with commands, earlier failures and integration details in [MEM-01-INTEGRATION-VERIFICATION](MEM-01-INTEGRATION-VERIFICATION.md):

- Formatting, API/Web type checks and API/Web production builds passed, exit 0. Web type checking reported zero errors and zero warnings.
- **1,266 unit and integration tests passed**: API unit 122, Web unit 126, API integration 401, Web integration 617. This is one complete final-source run, not a sum of partial runs from older candidates.
- **46/46 ordinary browser scenarios and 1/1 OIDC scenario passed**, exit 0. This includes human/Bot live Save, current-source changes, JavaScript-disabled POST search, exact grant selection, source-edit exclusion and both committed-response-loss regressions.
- The two retry regressions first failed against the live implementation: after a committed response was aborted and an expired cursor forced bootstrap, Save changed its key/confidence and duplicated memory; edit changed its key/expected version and added an extra revision. The same two real browser scenarios passed after retaining the exact submitted command independently of stream resets. They also passed in the final 46-scenario run.
- Native PostgreSQL: **14 registered, 14 skipped locally** because `TEST_MEMORY_DATABASE_URL` is absent. They are not native proof. The dedicated `postgres-memories` CI job provisions its own service/runtime role and exercises real guards, least privileges, concurrent idempotency, mandatory audit rollback, observed lock waits, current authority/source changes at delta/final publication, original sequence eligibility and original/derivative attachment purge.
- Compose: `infra/verify-memories.mjs` is syntax checked and wired after the private attachment check. Its running API/runtime-role acceptance remains external. The exact migration expectation includes actual 0019 and 0020.
- Root's independent Spec and the independently assigned Standards review both reported **CLEAN on final source tree `0f33d9b41358f50a67ebafc0c5f0e6a43fe625d1`**. The final delta review extends the earlier core, route-scope, non-enhanced search and integration conclusions. These are reviewer findings, not author self-approval.
- After the final browser process exited, explicit TCP probes returned `ECONNREFUSED` for both 4399 and 4173. Both ports were released to root and the dedicated merger. No local PostgreSQL or Docker was provisioned. No changes have been pushed.
- Dedicated combined merger verification, actual PostgreSQL/Compose execution and root ticket acceptance remain outstanding.

## Completed integration and merger seams

The complete COL-05 merge preserves its stream reader/BFF, typed lifecycle writers, one sequence namespace, deferred tail guard, CI/Compose wiring and deadline checks. Memory's manifest recheck remains before every delta and inside private `finishTransaction`; the final deadline check still follows completion audit/delivery, with rollback and fresh same-claim admission on timeout.

Streamed human/Bot messages get a live Save command and the exact current `versionEventId`. Before create, the BFF verifies that the route's current conversation is a group and matches the submitted group. Search permits only its exact empty `/search` action marker during list reload, so non-enhanced POST success/failure renders without putting search text in a URL.

`conversation-pending-command.ts` and the shared conversation page keep one bounded, scoped Save/edit command snapshot until explicit acknowledgment or discard. Feed replacement and bootstrap cannot change the original key, source/version or confidence/body. A retry restores the exact submitted fields and still receives fresh server authorization. Concurrent managed commands are blocked while the snapshot is retained; discard reloads the current form and does not undo a possibly completed operation. No automatic retry occurs.

The dedicated merger must preserve these shared page/helper and queue seams while adding later routing/Task-history work. This branch stops at schema 0020; later schema numbering and the combined acceptance gate remain root-owned.
