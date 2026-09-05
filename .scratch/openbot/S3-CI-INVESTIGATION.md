# S3 conditional-write connection regression

## Observed failure

Verify33948926135 failed the actual MinIO contract after its concurrent writes had correctly produced one success and one conflict. Verify33949842135, remote990895839c34523aea53e80b8cd007925f785aa3, repeated the failure on2026-09-05. Its object-storage job101262649095 recorded PUT200, PUT412/PreconditionFailed, then GET with no HTTP response status and SDK TimeoutError/ECONNRESET. No checksum or response-body error occurred. Five of six real S3 cases passed; BOT-02-E1 remains open.

The temporary diagnostic observed the public SDK send promise and body errors without replacing the promise, consuming the stream, or logging messages, credentials, keys or headers. It is removed by this fix candidate, including its helper, registration and diagnostic-only tests.

## Regression and candidate

The HTTP fixture can retire a conditional-write connection and reset its next request before response headers. Both sequential overwrite and concurrent-create cases failed at the subsequent read against unchanged production code. Both pass after disabling idle connection pooling for the SDK's HTTP and HTTPS agents. This matches the observed transport failure; only another actual service run can confirm the candidate resolves the MinIO case.

The pinned Smithy Node HTTP handler defaults both agents to keepAlive=true and accepts standard agent options through requestHandler. The candidate overrides only keepAlive, retaining SDK connection limits, immutable conditional writes, maxAttempts=1, error-body bounds, operation deadlines and caller cancellation. It opens fresh connections between operations rather than introducing an automatic retry with uncertain write results. The tradeoff is connection setup overhead for avatar storage.

The wire regressions assert exactly two PUT requests and one GET, one successful write, one object-already-exists rejection, and unchanged stored bytes. A retained CRC32 regression verifies correct response bytes and rejection/redaction of corrupt bytes without retry. The original six real-S3 assertions and actual service configuration are unchanged.

## Verification

Witnessed RED: both retired-connection tests fail with object_store_unavailable at the final read. Candidate GREEN:29 tests across the S3 wire contract, private local-store contract and avatar API; API TypeScript passes. The preceding diagnostic-preservation check passed30 tests before removal of the probes. No real S3 service or PostgreSQL is claimed locally. Independent review, integrated full verification and the actual CI retry remain required.

## Reviewed integrated candidate

S3 transport fix981ddc9 is independently CLEAN and integrated as `a9f0719204b3eaa0b1d378f5ee1449f36b58fd91`, tree `0e32462c7ddbb120183e9326d4b954876df8283a`. The dedicated merger's complete pnpm verify passed758 unit/integration tests (API88+278,Web40+352),21 ordinary browsers and one signed-OIDC journey,formatting/types/builds. All seven candidate files match exactly; no integration correction was needed. Independent review ran15 S3 wire tests and verified the pinned SDK honors HTTP/HTTPS keepAlive=false with the existing socket limit, unchanged deadlines/maxAttempts=1/checksum validation, removed diagnostics and byte-identical original real-S3 assertions. The actual MinIO retry remains mandatory for BOT-02-E1.

## Latest integrated evidence

BOT-02-E1 closed by [Verify33950565666](https://github.com/Blackman99/openbot/actions/runs/33950565666), all eight jobs successful on remote `6a611f9b0fe78b666fe63ab3c601a376c415fddd`, completed2026-09-05 at06:45:58 UTC. Published tree `065c73a6fe52d5f88cfd2abe520e94fb2d1c9fb2` exactly matches accepted local `3351d411a316652c7d698be1583ffa23d6050da5`, verified by fetch and pinned diff. The object-storage job101264648438 executed all six original real-S3 cases and seven private local-store cases successfully after the connection-pooling correction; temporary diagnostics and automatic retries are absent. The postgres-bots job101264648426 passed identity8,ACL9,avatar8 in three separate commands. Compose job101264648429 passed fresh/upgrade through0014, exact object/reference and conversation grants, actual Alpine Sharp loading, private runtime-volume roundtrip/ownership and all previous application/outage checks. Code and all five PostgreSQL jobs also passed. This closes the avatar release gate on actual services; seventeen tickets are now fully complete.
