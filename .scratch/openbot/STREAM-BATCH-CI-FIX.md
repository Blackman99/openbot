# Stream batch CI observation corrections

Unified test/CI source: `0d486814736ff78d0f10e3e5fa7429adf7a1f913`, tree `c77aa114b05e49bfd0cca167138e9ef54f2b7007`.
Parents: Task correction `e12d69482b3438478aa8842dc102db02fd65d74c` and MEM candidate `08856e0007a6b7c525baa26f4e83b5841c776709` (test/CI source `1e5f77a263718ed760541e9ee7ae6db73e36fcab`).
Integration baseline: `c45d95dde379efa0a0c7e6f1fa67e3ba71292cf8`; isolated branch `fix/stream-ci` in `.worktrees/fix-stream-ci`. The merge was conflict-free.

The complete behavioral diff has four paths: `apps/api/tests/postgres/tasks-runtime.test.ts`, `apps/api/tests/postgres/memories-runtime.test.ts`, `infra/verify-memories.mjs`, and `.github/workflows/verify.yml`. The two added Markdown evidence files are the only other changes. Production, migrations, runtime privileges, original ACs and progress metadata are unchanged; no COL-07, MEM-02, KNW or Provider taxonomy feature is incorporated.

## Actual CI failure and correction

CI run `33964449861` remains a failed run. Root's recorded aggregate is **11/14 jobs passed; 249 native cases passed and 4 failed**. The merger independently read the three saved failing-job logs below; local static checks do not replace those results.

| Actual observation | Correction retained in the unified source |
| --- | --- |
| Task job `101302400542`: 38 passed / 2 failed, exit 1. Successful routed execution produced five audited actor entries where the test expected four. | Assert the exact five event/actor pairs: `conversation.bot_message_created`, `task.completed`, `task.queued`, `task.routed`, `task.running`, all attributed to the actual member. Sorting removes incidental audit-row order without dropping or permitting extra events. |
| The same Task job: the routing-default CAS test queried `audit_events` through the runtime pool and received PostgreSQL `42501`. | Keep the runtime mutations and privilege assertions, and observe the exact group audit through the existing separate admin pool. |
| MEM job `101302400523`: 12 passed / 2 failed, exit 1. Its blocker requested `inspect` and then attempted `edit`, which requires `use`. | Request the existing write admission for the blocker; additionally prove the original and committed second revision before checking old-memory denial and current-list exclusion. |
| The same MEM job: cleanup expected a null command hash, contradicting actual migration 0018's retained 64-zero sentinel. | Assert the complete retained created/deleted chain and unchanged identity/sequence/actor fields, with null body/reason and exactly 64 zeroes; preserve cleanup, exclusion, retained-reference and publication-denial checks. |
| General Compose job `101302400531`: attachment verification passed, then memory verification stopped at `scope denial audit`, exit 1. The helper attempted audit SELECT under its append-only runtime pool. | Keep runtime API/seed/source operations and assert audit SELECT=false/INSERT=true. Emit one strictly validated safe receipt; the workflow separately observes exactly one matching audit using the PostgreSQL container. Full JSON equality rejects missing, duplicate or extra content-bearing audit metadata. No observer credential enters the API. |

Log directory: `/workspace/scratch/2bc98607b3a9/`.

| Log | SHA-256 |
| --- | --- |
| `ci339644-job-101302400542.log` | `4b90b5615e93d1c72fb94fe474a44d919998f8458dc1704b0b6bf3de3e312435` |
| `ci339644-job-101302400523.log` | `20138e1337e9528032c55bcb4cac4858c1b88ae3f1ca72400a4855e0a8cfc208` |
| `ci339644-job-101302400531.log` | `89b20a8a7aa7793ff4bc65ad3af511936dcc6668b758e0fa759069142206e82f` |

## Type correction and merger checks

Root witnessed the first Task correction typecheck fail in exec session `72145`, exit 2: `tasks-runtime.test.ts(1169,20)` and `(1169,26)` reported TS7006 for implicitly-any `left` and `right`. The `snapshot().audits` boundary propagated `any` through `map`; explicitly typing the audit array fixed it. Root's second typecheck, session `86188`, exited 0. This was a local type failure, not a native behavioral RED, and has no standalone saved log. The merger did not execute those two Root sessions.

The merger ran the following on the conflict-free combined source, using the three pre-existing dependency symlinks and `pnpm_config_verify_deps_before_run=false` for pnpm commands:

| Check | Actual result / evidence |
| --- | --- |
| `pnpm --filter @openbot/api run typecheck` | Exit 0; `stream-ci-fix-api-types.log` in the log directory above. |
| `pnpm exec prettier --check` on all four changed test/CI paths plus `MEM-01-NATIVE-CI-FIX.md` | Exit 0; `stream-ci-fix-format.log`. |
| `node --check infra/verify-memories.mjs` | Exit 0, direct tool result. |
| Parse complete workflow YAML with unique-key checking; extract the one memory step and run `bash -n` | Exit 0; `stream-ci-fix-workflow-static.log`; exact extracted shell in `stream-ci-fix-memory-step.sh`. |
| Compare parsed workflow against baseline after replacing only that memory step's `run` value | Exact equality; all 14 jobs and every other workflow value retained. This includes existing native jobs, migration literals and Compose stages. |
| `git diff --check` and `git diff --cached --check` before the merge commit | Exit 0. |

The MEM author's 49 focused tests and eight substituted-Docker shell outcomes are recorded separately in `MEM-01-NATIVE-CI-FIX.md`; the merger did not repeat them. The native stream 40-case pass and separate Compose Task/stream pass reported by Root remain distinct observations, not evidence that the failed general Compose memory step passed.

No native suite, PostgreSQL, Docker, browser, provider service or full verify was run during this merge. **All four existing external gates remain open.** Corrected native and general Compose GREEN require a new actual CI run. Independent review, Root acceptance and publication are pending; the Root worktree and remote were not changed by this merger.

## Independent acceptance

After the merger handoff, independent Spec (`/root/col04_spec_review`) and Standards (`/root/col06_web_standards`) reviews were both CLEAN at final commit `8691abecbd3d3a086f1bc9da331d5adfae8d2272`, tree `a5a1aa896a931d182d0dc4d016c061a2ac44ab2c`. Both reviewers checked the original failed CI evidence, unchanged production authority and exact correction blobs. Root accepted and fast-forwarded this candidate; this acceptance note changes no test or production source. Publication and corrected actual CI are the next gates, and no external gate is closed by this review.
