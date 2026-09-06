# BOT-02 avatar implementation evidence

Base: `47553b1e5331aeaa869d44e96537b38d53d9fd2b`. This note records implementation evidence. External service gates remain explicit until actual CI results are available.

## First tracer

- Existing BOT-01 lifecycle baseline: 11 tests passed after generating the fresh worktree's SvelteKit types. The initial run lacked generated `.svelte-kit/tsconfig.json`; that setup failure is not TDD evidence.
- First avatar HTTP test failed with 404 before routes existed. It then passed through actual Sharp decoding, a private LocalObjectStore, durable database intent, immutable version 2/current pointer/audit and authorized PNG delivery. The original version stays unchanged; its unavailable model does not prevent an avatar-only edit.
- Masquerading SVG bytes declared image/png initially returned 503. Signature validation and fixed image errors now reject with 400 before creating any intent/version.
- A structurally encoded APNG fixture initially decoded successfully. Explicit bounded PNG chunk checks now reject animation controls, including the single-frame APNG case that Sharp metadata does not expose as animation.
- Decoder saturation initially accepted a third request. A bounded concurrency/queue controller now rejects it; queued time counts toward the overall deadline, and a timed-out native operation retains its slot until the operation really settles.
- The independent local-storage subtask supplied checkpoint `8a8c1990c1713bce3bda1340821c0783e81c896e`, cherry-picked as `72a7439`. Five adapter-contract tests witnessed RED→GREEN, with seven local tests covering immutable concurrent saves, scoped IDs, private modes, symlink refusal, bounded reads and cancellation.

First combined targeted gate: 22 tests passed across `bots.test.ts`, `bot-avatars.test.ts`, `avatar-image.test.ts` and `local-object-store.test.ts`, using `--maxWorkers=4`. API types and formatting are checked at each checkpoint. Independent two-axis review is reserved for the final pinned candidate.

## Public and shared seams

- `PUT /api/v1/workspaces/:workspaceId/bots/:botId/avatar?expectedCurrentVersionId=<UUID>` accepts bounded raw image bytes. `DELETE` uses the same version precondition. Both return `{version}` and require current edit permission and trusted Origin.
- `GET`/`HEAD` on that path require current inspect permission; optional `versionId` reads a retained version of the same Bot. Responses are `private, no-store`, canonical `image/png`, and `nosniff`; no object key or direct URL is returned.
- `appendBotVersion(connection,access,change,clock)` is transaction-owned and currently accepts only an avatar-reference change. It checks the current-version precondition before a no-op, creates immutable configuration/author/time/number/rationale, advances the pointer, writes a mandatory safe audit, records a retained-object reference and queues the previous avatar for cleanup atomically. BOT-03 will extend the typed change for its approved edit/restore operations.
- `BotConfiguration.avatarObjectId` is optional for pre-avatar historical versions. A missing field and null both mean the deterministic default; clients cannot inject object references through Bot creation.
- ObjectStore identity is a stable nonsecret backend hash. Staged objects retain that identity; reconfiguration cannot silently map historical references into another bucket/root.

## Completed contract coverage

| AC | Implementation and evidence |
| --- | --- |
| 1 — edit/upload/replace/remove | Current workspace membership intersected with explicit Bot owner/editor, before decode and again after I/O. Version CAS applies to uploads/removal and before no-op. API tests cover editor/user roles, workspace-owner denial, invalid/oversized/malformed input, stale versions and cancellation. |
| 2 — actual image validation | Sharp 0.35.4 decodes PNG/JPEG under byte/dimension/pixel/depth bounds, checks signatures/MIME, rejects animated PNG control chunks, normalizes orientation and strips metadata. Tests cover APNG, truncated data, 16-bit PNG, oversized dimensions/pixels, JPEG EXIF rotation, saturation and deadline. |
| 3 — list/detail/default | Shared BotAvatar component uses a stable UUID-derived inline default. Optional avatarVersionId is emitted only for explicit inspectors and accepted by strict BFF decoders. Browser journey verifies display/upload/replacement/deletion. |
| 4 — private bytes | API checks inspect permission before storage and again before releasing bytes. BFF authenticated GET/HEAD uses fixed internal endpoint and refuses redirects. Responses are private/no-store/nosniff, never object URLs. API tests cover discovery, current membership/ACL, backend mismatch, missing and altered bytes; native fixture covers revocation while reads wait. |
| 5 — durable cleanup/history | Staged intent precedes I/O; final version/reference/audit/pointer changes use one transaction. Leased janitor retries failed/orphaned deletes and reconciles tombstones. Old version references retain old avatars. Local tests cover canceled saved upload, deletion retry, stale edit and failed save; actual rollback and lock interleavings belong to native PG gate. |
| 6 — adapter parity | Shared immutable save/read/new-key replacement/delete contract runs against private local filesystem and S3. S3 wire tests check conditionals, signing, bounded normal/error bodies, fixed error reconstruction, cancellation and no public ACL. Real-service contract also checks unsigned reads. |

## Checkpoints and additional RED → GREEN

- `c227241`: first complete actual decoder → private storage → API → immutable version tracer.
- `dd24868`: summary/BFF/private display and history-aware cleanup checkpoint.
- Storage final `f4a35732e6755268acb278fb16ae60c6700ac77a` was cherry-picked as `d374a46`; native fixture `3d22ab2e59123cc8bb5cc8c1077928c4894e2838` as `526b0ea`.
- Production cleanup/config tests initially failed for missing cleanup module and missing config. The worker now runs one bounded batch per minute without overlap, hides storage error details, retries on the next tick and drains during shutdown.
- Aborting after successful object I/O initially published a version. Signal propagation/checks now stop publication and leave a retryable staged intent. The test also verifies failed deletion then successful idempotent retry.
- Pre-aborted BFF upload initially forwarded credentials and reported success. It now returns a fixed failure without forwarding.
- A valid approximately 786 KiB PNG multipart upload failed under adapter-node's default 512 KiB request cap. The actual browser journey passed after setting BODY_SIZE_LIMIT=3M; the API remains limited to 2 MiB. The same journey exercises replacement, stale form conflict, current default after removal, historical image readability and workspace-admin discovery denial.
- Empty optional S3 values supplied by Compose initially failed configuration; absent endpoint/session-token semantics now work while nonempty invalid endpoint values remain rejected.
- Upstream deadlines are exercised through both upload JSON and private image response bodies. Provider error bodies never reach the UI; true 401 clears the session while 403/409/503 preserve it.

## Production and independent gates

The API creates the configured store and avatar service at startup and runs at most five cleanup candidates per minute. Compose mounts the private object-data volume into a non-root API with read-only root filesystem; the runtime image creates the mount point with mode0700 and API ownership. The Web adapter explicitly allows 3 MiB multipart bodies.

CI includes the root-authored storage-job commits `0189880` and `b144349` (picked as `e028cc8` and `a89d097`); independent review must cover that CI delta, not count root self-review. The real S3 fixture uses a pinned upstream MinIO image and write-quorum readiness, then a private bucket and shared contract. The native Bot avatar file runs in a separate Vitest command after BOT-01 to avoid fixed-runtime-role provisioning races. Compose additionally loads the actual Alpine Sharp binary and performs private-volume save/read/delete and permission checks as the runtime user.

No PostgreSQL service, S3 service or Docker execution is claimed locally. `TEST_BOT_DATABASE_URL` and `TEST_S3_*` opt-in gates must run in CI. Native fixture contains eight cases including actual CAS, observed pg_blocking_pids interleavings, post-I/O revocation, mandatory-audit rollback, exact column grants and immutable references. The S3 real-service fixture contains six cases. No unsupported local provisioning was retried.

## Final local verification

`pnpm verify` passed: formatting; API TypeScript and Svelte checks (zero errors/warnings); 88 API unit, 30 Web unit, 243 API integration and 284 Web integration tests (645 total); all 16 main browser journeys plus the separate real OIDC browser journey (17 total); both production builds. Source checkpoint `0af93fe8df9935fe8fd66815f52d1b51ae7adde7` received no changes after that gate began. A separate workflow parser checked all 33 shell steps and embedded JavaScript syntax. `git diff --check` passed.

The explicit native/S3 registration check reports 14 skipped tests across two files because their service variables are unavailable; this is not a service pass. Independent review status and the narrow follow-up are recorded below.


## Independent review and narrow error-message correction

Independent SPEC review was CLEAN at `1a99a55662f805d470d5dddae156bf9b682c7772` (source `0af93fe`), covering all six AC and 43 independently rerun targeted tests. Independent STANDARDS review ran 71 targeted tests and found one P3: a 503 message promised that the previous avatar was preserved, although a timed-out response or failed 200-response body can occur after the server commits. No other finding was reported; external service gates remain unchanged.

The correction changes only the Web mutation error message to an unconfirmed-result explanation with explicit reload-before-retry guidance. New upload/removal regressions exercise transport failure, truncated success JSON and invalid success JSON; the existing response-body deadline regression also requires the neutral message. All three failed against the former rollback promise, then passed with the correction. The affected Web avatar route, strict Bot client and Bot page suites pass 36 tests; Web typechecking reports zero errors/warnings and targeted formatting plus diff checks pass. Full-suite/browser results above belong to the original source checkpoint; they were not rerun for this isolated text correction. No ports were acquired and no domain/transaction code changed. Both independent affected-scope rechecks are CLEAN at `7466346f3b45ff1857f3d7d5de6fdebd2af22265`.

## Accepted integrated candidate

BOT-02 integrated as `9eb8f89c78afdca995280f2cbbb53784e2901027`, tree `4c1c7aaca906a9c0122c75bb6ee229b8c6473b26`. Both independent review axes are CLEAN at final `7466346f3b45ff1857f3d7d5de6fdebd2af22265`; the sole P3 unknown-outcome message was fixed and independently rechecked. The dedicated merged full `pnpm verify` exited0:704 unit/integration tests (API88unit+260integration, Web35unit+321integration),18 ordinary browsers and one signed-OIDC journey,formatting/types/builds. Root independently reviewed the three-file additive integration delta preserving both route families, exact BOT-04 grants, three serial Bot native commands and the S3 job. Frozen install, YAML/34 Bash steps/two embedded JS blocks/MJS syntax passed. Native PostgreSQL eight cases, actual S3 six cases and Compose remain the explicit BOT-02-E1 release gate; local skips are not execution evidence.

Standards affected recheck independently passed36 Web tests; Spec confirmed the final narrow delta. Integrated log: `/tmp/openbot-bot-02-integrated-verify.log`. Both browser ports were confirmed closed and leases released.

## Actual service CI result

BOT-02 Verify33948926135 on remote `1d46acbeafea4df02ecb72b071955bedc68f69cf` completed2026-09-05 at06:09:49 UTC with the object-storage job failing. Code and all four PostgreSQL jobs passed; postgres-bots executed identity8,ACL9,avatar8 cases successfully. Compose passed migration0013, actual Alpine Sharp loading and the private runtime-volume roundtrip/ownership checks plus prior application/outage checks. Real S3 passed five of six cases; the shared concurrent-save case confirmed exactly one successful save and one object-already-exists result, then its following GET failed with safe object_store_unavailable at contract line57. No overwrite assertion failed. BOT-02-E1 remains open; isolated diagnosis is in .worktrees/ci-s3-contract. Do not count the partial S3 run as a passed storage gate.

## Reviewed transport correction

S3 transport fix981ddc9 is independently CLEAN and integrated as `a9f0719204b3eaa0b1d378f5ee1449f36b58fd91`, tree `0e32462c7ddbb120183e9326d4b954876df8283a`. The dedicated merger's complete pnpm verify passed758 unit/integration tests (API88+278,Web40+352),21 ordinary browsers and one signed-OIDC journey,formatting/types/builds. All seven candidate files match exactly; no integration correction was needed. Independent review ran15 S3 wire tests and verified the pinned SDK honors HTTP/HTTPS keepAlive=false with the existing socket limit, unchanged deadlines/maxAttempts=1/checksum validation, removed diagnostics and byte-identical original real-S3 assertions. The actual MinIO retry remains mandatory for BOT-02-E1.

## Latest integrated evidence

BOT-02-E1 closed by [Verify33950565666](https://github.com/Blackman99/openbot/actions/runs/33950565666), all eight jobs successful on remote `6a611f9b0fe78b666fe63ab3c601a376c415fddd`, completed2026-09-05 at06:45:58 UTC. Published tree `065c73a6fe52d5f88cfd2abe520e94fb2d1c9fb2` exactly matches accepted local `3351d411a316652c7d698be1583ffa23d6050da5`, verified by fetch and pinned diff. The object-storage job101264648438 executed all six original real-S3 cases and seven private local-store cases successfully after the connection-pooling correction; temporary diagnostics and automatic retries are absent. The postgres-bots job101264648426 passed identity8,ACL9,avatar8 in three separate commands. Compose job101264648429 passed fresh/upgrade through0014, exact object/reference and conversation grants, actual Alpine Sharp loading, private runtime-volume roundtrip/ownership and all previous application/outage checks. Code and all five PostgreSQL jobs also passed. This closes the avatar release gate on actual services; seventeen tickets are now fully complete.
