# BOT-06 verification and integration handoff

Ticket: `17-bot-06-archive-restore-and-soft-delete-bots.md`, all six acceptance criteria.
Base: accepted COL-02 `28ce290e994f769219eb16b17565eb589dc12e16`.
Production source: `64944ed6bee07721ed6fe53f7221620dbb4ff8a1`.
Final source/test candidate: `839254997ef8dcb7f37c384e476b904191431f92`, tree `404caae511a3aadf985f889b539bbd466d04c614`.

## Behavior and acceptance evidence

Lifecycle belongs to the stable Bot identity, independently of immutable configuration versions. Current explicit owners who remain workspace members can archive, restore, soft-delete, or undo deletion. The owner recovery list makes deleted Bots reachable without returning them to default or usable lists. All state changes and mandatory content-free audits share one transaction; repeated effective commands preserve the recorded state and do not add audits.

| Acceptance criterion                                               | Implementation and evidence                                                                                                                                                                                                                                                                                                                                                                                                                        |
| ------------------------------------------------------------------ | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Archive stops new use while retaining configuration and history    | Shared `lockAuthorizedBot(..., 'use')` rejects archived/deleted Bots, including direct conversation creation/message work and indirect group admission. API tests retain direct history and group grants; the lifecycle browser journey retains the original version and instructions.                                                                                                                                                             |
| Restore revalidates the enabled, accessible model                  | Restore and undo-to-active admit the actual owner's current exact model and verified Basic capability. API and browser tests reject unavailable bindings; native definitions cover queued provider changes and commit ordering.                                                                                                                                                                                                                    |
| Soft deletion hides selectors/default lists and records its window | Default lists exclude deleted Bots; usable lists admit only active explicit ACL Bots. Deletion records one timestamp and a fixed 30-day recovery deadline. The owner recovery page displays the persisted window.                                                                                                                                                                                                                                  |
| Only current owners can transition or recover during grace         | API role matrices reject workspace/group administrative bypass, editors/users, discovery-only actors, and removed workspace members with HTTP 403. Undo rejects at the exact deadline; browser and Web route tests enforce owner-only lifecycle navigation and actions.                                                                                                                                                                            |
| Idempotence and stable historical identity                         | API tests cover repeated archive/restore/delete/undo, retained pre-deletion state, fixed deadlines, unchanged immutable versions, and stable direct/group Bot markers. Native definitions cover concurrent duplicate commands and retained objects/references.                                                                                                                                                                                     |
| API/UI transitions, audits, and no physical-erasure claim          | Real Fastify injection and pg-mem integration exercise all commands and exact safe audits; strict Web clients consume the actual API seam. Rendered pages and two browser journeys cover lifecycle controls, model rejection, recovery, expiry, and unknown mutation outcomes. Native definitions cover mandatory-audit rollback and forbidden erasure privileges. UI and tests explicitly retain configuration, avatars, and historical identity. |

The browser API fixture is a UI seam. It does not prove PostgreSQL locking, transaction rollback, deployed grants, or upstream provider transport.

## Local verification

The original author completed the frozen `64944ed` nonbrowser gate on 2026-09-05: **920 unit/integration tests** (API 409, Web 511), repository formatting, API/Web types, and both production builds. That result was supplied in the author handoff; no full nonbrowser log was retained for this finishing pass. Root explicitly assigned the dedicated merger to record the authoritative combined `pnpm verify` result rather than repeat an unchanged nonbrowser gate here.

The finishing pass verified:

| Gate                                     | Actual result                                                                                                          |
| ---------------------------------------- | ---------------------------------------------------------------------------------------------------------------------- |
| Initial targeted lifecycle Chromium run  | Two passed in 27.7 seconds.                                                                                            |
| Ordinary Chromium run at `08462e6`       | 27 passed; one inherited group refresh synchronization failure in 1.9 minutes. Both lifecycle journeys passed.         |
| Corrected group + lifecycle Chromium run | Four passed in 26.6 seconds at the final candidate.                                                                    |
| Signed-OIDC Chromium run                 | One passed in 27.2 seconds at the final candidate.                                                                     |
| Changed native expectation files         | Focused formatting, API TypeScript, and diff checks passed.                                                            |
| Browser readiness correction             | Focused formatting and Web typecheck passed with zero errors and zero warnings.                                        |
| Native suite registration                | Identity eight, avatar eight, and lifecycle 24 cases all explicitly skipped because `TEST_BOT_DATABASE_URL` is absent. |

Browser commands ran sequentially from `apps/web` using the unchanged Playwright configuration and its normal production-build/server commands. Initial startup aborted before tests because pnpm 11 attempted dependency reconciliation for shared worktree links. The lockfile and both package manifests matched the root installation. Setting `pnpm_config_verify_deps_before_run=false` for the browser invocation preserved the existing installation; no dependency install, shared-module replacement, or checked-in configuration change was made.

Logs: `/tmp/openbot-bot06-targeted-browser.log`, `/tmp/openbot-bot06-ordinary-browser.log`, `/tmp/openbot-bot06-focused-browser.log`, and `/tmp/openbot-bot06-oidc-browser.log`.

After OIDC completed, independent TCP checks of both leased browser ports, 4399 and 4173, returned `ECONNREFUSED`. The ports were released for dedicated merged verification.

The first ordinary run's failed group test filled the time field while cached client navigation was still clearing the prior action form. Its final snapshot showed the Bot selector reset and history restored to `future-only`, with no time field. This matches independently reviewed CI fix `5626312aae23870c968180e7f169c4032864f197`. Commit `8392549` applies exactly that fix's comment and visible `future-only` readiness assertion; no production code, fixture, timeout, or Playwright configuration changed. Root requested the focused four-case rerun plus OIDC, with the complete ordinary suite to run once in dedicated combined verification.

## Independent review and finishing corrections

- Independent Standards reviewer `/root/bot_lifecycle_standards` found two older native grant expectations that still listed only `current_version_id` and `visibility`. Commit `08462e6232c1eba110c906b22503c4d59c945a5e` adds exactly the four new lifecycle columns to both sorted allowlists, preserving negative guards and production grants. The reviewer rechecked the eight-line correction CLEAN and reported no other findings.
- Independent Specification reviewer `/root/bot_copy_lifecycle_spec` reported CLEAN at `08462e6` against all six acceptance criteria and changed no files.
- Root inspected the only subsequent source/test delta, the two-line group readiness correction, and confirmed it exactly matches accepted `5626312` and is CLEAN. Production source remains unchanged after `64944ed`.

Final ticket/evidence edits are documentation only. Root retains acceptance, integration, publication, and global metadata ownership.

## BOT-06-E1: actual PostgreSQL and deployed-role gate

**Still open.** The 24 lifecycle native cases are defined, not locally executed. See [BOT-06-NATIVE-EVIDENCE](BOT-06-NATIVE-EVIDENCE.md) for exact coverage and the sequential CI command. CI requires a nonempty database URL and runs the lifecycle suite after the identity, ACL, avatar, and version suites, allowing each suite to close its pools before runtime-role credential rotation.

Migration `0016_bot_lifecycle` adds the stable identity fields after unchanged 0015. Actual PostgreSQL must prove precise column grants, immutable/retained references, owner and provider admission ordering, concurrent idempotence, expiry after lock waits, audit rollback, and historical direct/group boundaries. Deployed Compose privilege and migration evidence remains root-owned. Local skips, pg-mem tests, and browser fixture success cannot close this gate or claim physical erasure.

The dedicated merger will run the complete combined `pnpm verify` before acceptance; its result remains pending in this author handoff.

## Compose expectation correction after the author handoff

Subsequent COL-04 inspection found two Compose expectations missed by the earlier reviews: the ordered migration ledger still ended at 0015, and the Bot column-privilege assertion omitted the lifecycle columns. The focused follow-up from `f0e7731` changes only those two workflow expectations and this note. The ledger now includes actual `0016_bot_lifecycle`; the sorted ten-column privilege assertion grants exactly current version, visibility, and the four lifecycle columns, while creation metadata, ID, and workspace remain false. Existing table-wide, ACL, immutable-version, and other negative guards are unchanged.

The expectations were checked against the actual migration registration, Bot schemas, and runtime-role provisioner. Workflow YAML parsing, `bash -n` for the two affected Compose steps, focused Prettier, and `git diff --check` passed. No new unit tests, PostgreSQL, Docker, or browser execution was performed. Actual Compose/native evidence and BOT-06-E1 remain open; root owns review and integration of this correction after its current combined gate finishes.
