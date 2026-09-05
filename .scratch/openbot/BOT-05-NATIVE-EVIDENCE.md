# BOT-05 restricted-role PostgreSQL evidence

## Gate status

**Open: actual native PostgreSQL CI execution is still required.** This environment has no `TEST_BOT_DATABASE_URL`; no local PostgreSQL, Docker, or provisioning execution is claimed. Discovery and TypeScript checks below do not prove native transaction, lock, grant, or trigger behavior.

## Suite and boundaries

`apps/api/tests/postgres/bot-copy-runtime.test.ts` contains 17 Vitest cases. Its setup uses the real migrations and `infra/postgres/grant-runtime-privileges.mjs`, then connects as `openbot_runtime`. Administrative SQL is limited to test observation, intentional blocking, and mandatory-audit privilege fault injection. The provider probe supplies Basic capability fixture evidence; it is not an upstream transport test. Bot, ACL, membership, provider admission, avatar reads, and copy operations use the production service/repository paths and real SQL when the gate runs.

Coverage includes:

- Read-only preview of the current source configuration by a Bot `user`, followed by a new private identity, exactly one version numbered one, the actor as sole owner, and exact secret-free `bot.copied` provenance. Source identity, versions, ACLs, and audits remain unchanged. Workspace administrators without a direct Bot grant cannot preview or confirm a discoverable source.
- Independent model admission: inaccessible source personal binding is reported in preview and rejected at confirmation; a usable personal binding owned by the actor can replace it.
- Real audit insertion denial rolls back copied identity, version, owner ACL, avatar reference, and audit together. Source records and original avatar bytes remain intact, with no new object rows or filesystem entries.
- A source edit blocked at mandatory audit insertion holds copy behind its workspace lock. Once the edit commits, the stale confirmation fails and a fresh preview observes the new current version.
- Preview and confirmation each wait behind real Bot ACL revocation and workspace removal service operations, then reject after the revocation commits. The reverse order also runs for both revocations: an admitted copy remains invisible before commit and retains its authorization through commit before the revocation proceeds.
- A copy queued behind source soft deletion rejects after deletion commits even though the configuration version ID did not change; owner recovery then permits a new active copy.
- Disabled, rebound, capability-unavailable, and deleted replacement model connections are rechecked after the real personal provider scope lock wait. No copy rows or audit commit after failed admission.
- An admitted copy waits for the avatar object row while retaining the workspace lock; real cleanup then waits behind that copy. The committed copied reference and source historical reference retain one live object and one file. Both source and copied avatar reads succeed, including after source avatar removal and another cleanup pass.
- Preview and confirmation recheck the live avatar state after acquiring an object row lock. The test-only transition to `deleting` is deliberate storage-state fault injection; normal cleanup is not claimed to delete an object with an immutable source reference. Denial leaves all copy-related records and files unchanged.

Every concurrent test observes `pg_stat_activity.wait_event_type='Lock'` and `pg_blocking_pids`. Dependent waits use the actual immediately preceding operation's PID; they do not assume that multiple waiters all directly wait on the original blocker. Cleanup follows the production workspace-before-object lock order.

## Local commands and actual results

On 2026-09-05:

| Command | Actual result |
| --- | --- |
| `pnpm exec prettier --write apps/api/tests/postgres/bot-copy-runtime.test.ts` | Exit 0; formatted the new suite. |
| `pnpm --filter @openbot/api exec vitest run tests/postgres/bot-copy-runtime.test.ts` | Exit 0; one test file and all 17 tests **skipped** because the database URL is absent. |
| `pnpm --filter @openbot/api run typecheck` | Exit 0. |

## CI wiring and remaining evidence

The parent-owned `.github/workflows/verify.yml` `postgres-bots` job now runs `pnpm --filter @openbot/api exec vitest run tests/postgres/bot-copy-runtime.test.ts` after `bot-versions-runtime.test.ts`. Each suite runs in a separate sequential command so its runtime-role password provisioning cannot race another Bot suite.

The root release gate must record the actual CI run and commit/tree, successful native case count, and deployed runtime/Compose outcome before closing BOT-05's native evidence. No CI pass is asserted by this note.
