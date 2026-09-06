# COL-09 implementation evidence

This is an in-progress ticket checkpoint, not acceptance. Root owns dependency
integration, both independent review axes, the dedicated merge and publication.

## Test-first slices observed on 2026-09-05

- Real Fastify retry route: 404 RED, then 202 with one queued second Run,
  unchanged Task/trigger, stable same-command receipt and unchanged original Run.
- Actual second-attempt worker audit: RED reported attempt 1 for the second Run;
  GREEN reports the persisted candidate attempt. The unordered audit assertion
  was corrected before reproducing that production defect.
- Run history route: 404 RED, then GREEN across 22 legitimately created attempts.
  A retained cursor omits a later attempt and reaches every earlier Run using
  default 20/max 50 pages even after provider disablement.
- Actual API to strict Web client: two existing tests RED on the new explicit
  current Task DTO; GREEN after required `runCount` and `olderRunsCursor` parsing.
- Retry/history Web client: 15 RED cases for missing methods, then GREEN,
  including stable older receipts alongside later current state, safe 409s,
  exact response allowlists and bounded ordered history.
- Web routes and SSR: nine RED cases for missing retry/history actions and
  controls, then GREEN; the history page separately failed missing-module before
  its implementation. Four relevant Web files now have 64 passing cases.

Nine API retry integration cases pass, including real provider/worker flow and
the actual Fastify to BFF retry/history boundary. Additional access regressions
verify original-human-only execution in a group, no Bot-owner credential proxy,
pinned old configuration/model after a new version, old grant revocation despite
same-Bot reinvitation, preserved history, stale/current state conflicts and
stable replay after a later command. Initial API and Web type checks pass after
updating the owned fixtures. Current edited/tombstoned trigger regressions verify
that retry retains the trigger identity/horizon while respecting current source
projection, without replaying old bodies or including later-created messages.

## Integration with the real 0019 development dependency

The first COL-09 checkpoint is `3adaa72`. Root approved merging its accepted
`86c77c6` baseline (including real ATT-01/0018), then the COL-05 development
checkpoint `6a8b9e88`. These dependency imports are not independent acceptance of
COL-05. The only Git conflict was equivalent `Candidate.attempt` additions and
SELECT field order; resolution retains one persisted attempt and all stream
behavior.

An actual integration regression first observed zero queued delivery frames for
the retry instead of one. Calling `appendQueuedRunState` after the Task update,
before the mandatory `task.retried` audit, makes that test pass with exactly one
frame and retained delivery receipt across replay. This uses COL-05's private
allocator and durable deduplication, with no additional allocator.

The complete API integration run initially found three old COL-05-dependent
expectations: the migration/table manifests omitted actual 0019, and a Task test
assumed Bot output immediately followed the trigger. Exact manifests and a
unique scoped persisted-output receipt assertion fix them. The minimal two-file
patch was shared with the COL-05 owner unchanged.

After those fixes: API unit **106**, API integration **385**, Web unit **68**, Web
integration **561**, repository format, both type checks and both production
builds pass. All **five Task browser cases pass**, including two new journeys
exercising lost server and lost browser responses, unchanged retry confirmation
after completion, older failed evidence, one final answer and the
beyond-first-page message locator. Playwright exited successfully and both
leased ports were confirmed closed before release to the COL-05 owner.

## Actual migration composition

- Root approved actual COL-06 dependency `1fd4a5e`, including the real MEM
  `0817543` 0020 and COL-05 0019 sources. All ten merge conflicts were resolved
  by retaining both requirements: current-attempt/history plus optional routing
  summaries, private retry and routing routes, current source admission and all
  independently added tests. Focused pre-0022 gates passed **37 API / 75 Web**.
- Removed the provisional retry schema fixture, then witnessed **11 RED** cases
  from the missing registered migration/table. Registering
  `0022_failed_task_retries` after real 0021 made all **21** migration/retry cases
  pass. Runtime has SELECT/INSERT on retained retry commands and cannot execute
  the new guard functions; existing lifecycle column grants stay narrow.
- Reproduced both deadline regressions against the combined memory/routing
  source, then applied `aaa5b19`'s exact delta/final production changes. Its
  fixture addition retains the separately introduced auth field. Both deadline
  cases now pass without removing current-memory checks. This imports the
  deadline fix, not all later COL-05 HTTP/UI changes or acceptance.
- The group retry regression now covers both explicit mention and automatic
  local matching. Changing to another default Bot/model preserves the initial
  raw routing row and full decision, original Bot version/grant and strict Web
  summary. The combined deadline/retry/routing gate passes **25** cases.
- Full composed nonbrowser checks pass: **126 API + 72 Web unit** and
  **423 API + 590 Web integration** cases (**1,211 total**), both type checks
  (Web zero errors/warnings), both production builds and repository formatting.
  Native discovery reports **40 skipped**, which establishes registration only.
- On the frozen composed source, all **five Task browser journeys pass again**
  in 40 seconds. Playwright exited zero; ports 4399/4173 were confirmed closed
  before releasing the lease. This is the focused composed-source gate; root
  still owns the complete browser gate after all shared UI integrations.

## Gates still open

- Seven new native cases are registered in `tasks-runtime.test.ts`: observed same
  and different-key contention, mandatory-audit rollback, provider lock-wait
  revocation, exact-grant replay revocation, retained receipt privileges and
  orphan-Run/terminal mutation guards, and successful second-attempt execution
  with credential rotation plus old-delta/final fencing. The seven incoming
  routing cases and their extended receipt snapshot are also preserved. All **40** native cases are
  **unexecuted** without `TEST_TASK_DATABASE_URL`. The native suite deliberately requires actual
  migration 0022; no fixture-only migration is used for native evidence.
- Native cleanup now transitions Run and Task together in one transaction to
  honor the planned deferred consistency guard. pg-mem tests do not establish
  PostgreSQL trigger or lock semantics.
- Native/Compose execution, root's final combined browser gate and both independent reviews
  remain pending.
