# COL-04 API and worker verification

Core implementation pin: `d609b63`. This includes accepted BOT-06 merge
`ae567149a1e741a830a244f751c379af50c9a523`, immutable migration
`0016_bot_lifecycle`, and registered migration `0017_single_bot_tasks`.
No fixture installs a provisional Task schema.

## Implemented behavior

- The authenticated submission transaction records one human trigger, Task,
  attempt 1 queued Run, and mandatory audits. The exact original command/key
  replays its retained Task. Group submissions require an explicit active grant
  and the triggering human's own provider rights.
- Persisted reads expose pinned Bot/version identity, safe provider/model details,
  cumulative usage, fixed failures, and one final Bot output receipt. Bot outputs
  retain Bot authorship and reject human edit, deletion, and version controls.
- Separate `src/worker.ts` production entry uses the PostgreSQL queue. Claim and
  finish each reauthorize with the shared lock order. The committed claim retains
  token, deadline, provider connection/revision, protocol, and model before I/O.
  Full generation completion, fresh authority, and claim fencing are required to
  publish the one output and terminal status/audits atomically.
- Missing encryption configuration reports `task_worker_unconfigured`, keeps the
  worker process alive, and opens no queue connection. Configured startup checks
  the exact migration ledger. Shutdown aborts the current call and waits for the
  adapter to settle. An expired claim never starts provider I/O.
- PostgreSQL guards preserve Task/Run identity, enforce one-way transitions,
  reject mismatched triggers and model bindings, and validate canonical Bot output.
  Runtime grants permit only required status/claim/result columns; no retained
  table deletion, truncation, schema changes, or guard execution is granted.

## Local evidence

- Repository formatting check: passed.
- API unit suite: 18 files / 92 tests passed.
- API integration suite at the implementation pin: 43 files / 338 tests passed.
- API TypeScript check and production build: passed.
- New Compose task YAML and every shell block: parsed successfully.
- The deterministic Compose provider fixture was exercised with the real OpenAI
  Chat adapter over a local HTTP connection: held success stream, final text,
  repeated cumulative usage, terminal completion, and failed stream normalized
  as failure without a terminal completion all passed.

Observed red-to-green regressions include cross-conversation trigger acceptance,
missing migration 0017/tables, provider revision zero rejection, keyless worker
process exit 13 from unsettled top-level await, and an expired claim starting one
provider call instead of zero. Focused tests passed after each fix.

## Required external evidence

The native helper owns `tests/postgres/tasks-runtime.test.ts` and its isolated
`postgres-tasks` CI job. The configured `compose-tasks` job creates and replays a
queued Task with a keyless worker, starts the configured worker while API/Web are
stopped, inspects persisted running state, verifies success and failure, then
restarts API/worker and reloads the retained history and Bot response.

No local PostgreSQL or Docker instance was provisioned. Native skip/discovery and
shell parsing do not close those gates. Actual PostgreSQL/Compose success, the Web
integration/browser evidence, and both independent review axes remain required
before ticket acceptance. Core commits were checkpoints, not acceptance claims.

This slice adds no automatic retry, fallback, cancellation UI, crash reclaim,
routing, or claim of exactly-once external model execution. Queued Runs resume on
restart; uncertain running attempts remain retained for the later recovery ticket.
