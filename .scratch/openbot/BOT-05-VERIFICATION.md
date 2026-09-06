# BOT-05 author verification

## Scope and dependency boundary

Original approved base: `b71fa89f96b6451519a250084d54e09f06e4d1ff`.

The author incorporated accepted COL-02/root through `8ad6267` and the verified BOT-06 core checkpoint `e8964f2` before completing lifecycle copy guards. The resulting comparison base is `c389f993fe0547a34bd5fef860095a248bc05dcb`. Review the BOT-05-only delta from this base. The BOT-06 checkpoint is a dependency artifact, not acceptance of that complete ticket. Publish BOT-05 only after complete BOT-06 acceptance, with a dedicated additive merge and integration verification.

## Acceptance mapping

| Ticket criterion | Implementation and evidence |
| --- | --- |
| User-or-higher preview lists included/excluded fields | Actual API tests cover direct Bot user versus workspace administrator, discovery-only and indirect group-grant viewers. Preview and UI list exact included/excluded categories; preview/cancel write nothing. |
| New stable Bot ID/version 1/sole actor owner | Actual API and strict BFF tests assert new IDs, private/active identity, version one, actual author and sole owner ACL. |
| Reviewable configuration only | Copy constructs a typed field allowlist; credentials, ACLs, history, memory, file contents and prior audits are excluded. Avatar reuse checks current same-Bot retained reference plus live same-workspace object. |
| Accessible replacement when source model unusable | Actual actor's private replacement is admitted; source personal model cannot be used by an unrelated direct Bot user. Disabled, stale, inaccessible and malformed selections fail without destination records. UI requires explicit replacement. |
| Cancel/validation failure create nothing | Actual API snapshots cover preview, wrong Origin, malformed payloads, stale CAS and unavailable models. Native suite defines real audit rollback, current source/revocation/provider/object waits and no orphan file/record evidence; actual CI execution remains open. |
| Response/record secret scan and copy audit | Actual API and native cases scan receipts/new configuration/audit records for seeded connection key and sensitive-header values. `bot.copied` contains only source/destination IDs, version and workspace provenance. |

Additional regressions cover copied avatar read/edit/replace/restore/remove and cleanup; public raw-object-ID rejection; source configuration changes and independent copy configuration; explicit direct group-grant denial; archived-to-active copy; deleted owner/user denial until owner recovery; new active DTO validation; exact Origin, bounded body/response handling and upstream body deadline; unknown mutation result handling without promising rollback.

## Test-first checkpoints

- Actual preview route initially returned404 instead of200; API/domain transaction slice made it green.
- Avatar preview initially omitted the authorized reference; the shared retained-reference validation and atomic copy reference write made copied reads/edits/restores/cleanup green.
- Direct Bot user detail initially lacked the copy action; review UI/navigation made it green.
- After BOT-06 core integration, actual copy receipts omitted `lifecycleState` and strict BFF rejected them; active receipt made them green.
- Deleted-source preview returned200 instead of403, the copy link remained visible, and the BFF accepted an archived copy receipt; explicit transaction/UI/receipt guards made all green.

## Execution results

Final repository gate: `pnpm verify` exited0 on2026-09-05. All931 unit/integration tests passed (API88 unit +323 integration; Web56 unit +464 integration), as did30 ordinary Playwright scenarios, one signed-OIDC scenario, formatting, both typechecks and both production builds. Log: `/tmp/openbot-bot05-verify.log`. Ports4399/4173 were confirmed closed and released.

The first integrated full run found one BOT-06 core fixture mismatch: the original exact created-Bot assertion in `apps/api/tests/integration/bots.test.ts` omitted the newly required `lifecycleState: 'active'`. The expectation was aligned and its11 tests passed before the complete final gate was rerun successfully. BOT-06 author was notified to carry the same shared fixture alignment. No lifecycle product behavior was changed by that fixture correction.

Focused actual API/lifecycle: 21 tests passed. Focused BFF/page/SSR: 42 tests passed. Targeted Playwright: all four copy scenarios passed (review/cancel/user replacement, stale and lost receipt, revoked/discovery authority, deleted-source rejection). API native suite discovery: one file/all17 tests skipped because no `TEST_BOT_DATABASE_URL` is available; this is not native transaction evidence. See `BOT-05-NATIVE-EVIDENCE.md`.

The original pre-lifecycle full nonbrowser gate passed858 tests (88 API unit,50 web unit,294 API integration,426 web integration). These are historical checkpoint counts; the final integrated gate below supersedes them.

## Remaining independent gates

- Independent Standards axis and independent Specification axis against the frozen BOT-05-only candidate are required; the author and native test author do not self-approve those axes.
- Dedicated merge must wait for accepted full BOT-06, preserve current granted access/privileges and run the integrated repository gate.
- Real PostgreSQL `postgres-bots` CI must execute all17 copy cases under `openbot_runtime`. No local native, Docker or provisioning success is claimed. The sequential CI step is present after the Bot version suite.
