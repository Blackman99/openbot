# COL-06 API and migration checkpoint

This is a development dependency checkpoint, not whole-ticket acceptance or a
published snapshot. It composes routing work through dcefd68 with accepted e51fafe4
and the actual MEM core 0817543 (which includes actual COL-05 migration0019).
Migration0020 is unchanged; this checkpoint registers real
0021_deterministic_group_routing, its immutable receipt/settings guards and narrow
runtime grants. No reserved predecessor was filled with a placeholder.

The Task-service merge keeps structural automatic/explicit admission and persisted
routing receipts, plus the dependency's transactional appendQueuedRunState. The
memory selectors and current-source checks remain in the worker/delta path.
Group Task DTOs expose only the optional bounded {algorithm,reason} summary. The
strict Web Task client now accepts an automatic selected grant, distinguishes
explicit mention replay, rejects malformed/private summary fields, and preserves
an automatic-choice draft when no candidate is eligible.

## Evidence

- Witnessed RED: actual migration registration/table expectations lacked0021;
  focused matcher/routing/migration33 passed after registering it.
- Witnessed RED: two automatic group submissions and explicit mention were rejected
  by the old strict Web contract. Two further regressions showed unknown routing
  errors and blank automatic form choice rejected before submission. All47 Task
  client/page integration cases now pass; the actual Fastify/domain HTTP integration
  also submits/reloads automatic routing through the strict Web client.
- Full nonbrowser composite: API126 + Web69 unit cases; API411 + Web568 integration
  cases. The full integration invocation initially exited1 on exactly one old
  sequence2 assertion (actual5 after typed stream transitions); the remaining978
  integration cases passed. The precise already-authored aaa5b19 test correction
  asserts one Bot ledger row bound to conversation/Run, its exact receipt and a
  sequence after the trigger. All three cases in that repaired file passed.
  This is1174 distinct passing cases across that composite, not one full verify0.
- Full types passed (Web zero errors/warnings), formatting passed, both builds passed.
- Added seven native routing cases to the existing tasks-runtime suite: observed
  concurrent idempotency, current rights after waits, retained decision/replay,
  mandatory audit rollback, restricted immutable/same-scope rows and default CAS.
  Native PostgreSQL was not available or executed locally; no skip counts as pass.

External service verification, complete Web/real-browser integration, both whole-
ticket independent review axes and dedicated integration remain required. The
separately reviewed Web helper76047c0 is not yet part of this checkpoint.
