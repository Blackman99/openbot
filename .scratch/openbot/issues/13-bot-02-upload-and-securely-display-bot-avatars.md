---
sequence: 13
id: BOT-02
title: "Upload and securely display bot avatars"
status: complete
blocked_by:
  - BOT-01
labels:
  - bot
  - files
  - object-storage
  - vertical-slice
  - mvp
---

# BOT-02 — Upload and securely display bot avatars

## Outcome

Bot owners and editors can upload, replace, and remove avatars through a shared local or S3-compatible object-storage abstraction.

## Blocked by

- [BOT-01](12-bot-01-create-and-inspect-a-persistent-bot-identity.md)

## Acceptance criteria

- [x] Users with edit access can upload, replace, and remove avatars within supported format and size limits.
- [x] The server validates actual file content and dimensions rather than trusting extensions or client Content-Type.
- [x] Bot list and detail views show the avatar, with a stable bot-ID-derived default when none exists.
- [x] Private avatar reads enforce the bot ACL, and direct object URLs cannot bypass authorization.
- [x] Upload or database failure preserves the previous avatar; successful replacement queues the old object for retryable cleanup.
- [x] Local and S3-compatible backends pass the same save, read, replace, and delete contract tests.

## Non-goals

- General attachment ingestion or knowledge extraction
- An image-cropping editor
- Public CDN configuration

## Implementation contract

Follow [AVATAR-STORAGE-CONTRACT](../AVATAR-STORAGE-CONTRACT.md) and the shared immutable append rules in [BOT-CONTRACT](../BOT-CONTRACT.md). BOT-01 and BOT-04 are fully complete, including actual PostgreSQL/Compose CI. BOT-02 retains its own explicit service evidence gate below.

## Accepted integration and external gate

BOT-02 integrated as `9eb8f89c78afdca995280f2cbbb53784e2901027`, tree `4c1c7aaca906a9c0122c75bb6ee229b8c6473b26`. Both independent review axes are CLEAN at final `7466346f3b45ff1857f3d7d5de6fdebd2af22265`; the sole P3 unknown-outcome message was fixed and independently rechecked. The dedicated merged full `pnpm verify` exited0:704 unit/integration tests (API88unit+260integration, Web35unit+321integration),18 ordinary browsers and one signed-OIDC journey,formatting/types/builds. Root independently reviewed the three-file additive integration delta preserving both route families, exact BOT-04 grants, three serial Bot native commands and the S3 job. Frozen install, YAML/34 Bash steps/two embedded JS blocks/MJS syntax passed. Native PostgreSQL eight cases, actual S3 six cases and Compose remain the explicit BOT-02-E1 release gate; local skips are not execution evidence.

## Actual service CI result

BOT-02 Verify33948926135 on remote `1d46acbeafea4df02ecb72b071955bedc68f69cf` completed2026-09-05 at06:09:49 UTC with the object-storage job failing. Code and all four PostgreSQL jobs passed; postgres-bots executed identity8,ACL9,avatar8 cases successfully. Compose passed migration0013, actual Alpine Sharp loading and the private runtime-volume roundtrip/ownership checks plus prior application/outage checks. Real S3 passed five of six cases; the shared concurrent-save case confirmed exactly one successful save and one object-already-exists result, then its following GET failed with safe object_store_unavailable at contract line57. No overwrite assertion failed. BOT-02-E1 remains open; isolated diagnosis is in .worktrees/ci-s3-contract. Do not count the partial S3 run as a passed storage gate.

## Actual service gate closure

BOT-02-E1 closed by [Verify33950565666](https://github.com/Blackman99/openbot/actions/runs/33950565666), all eight jobs successful on remote `6a611f9b0fe78b666fe63ab3c601a376c415fddd`, completed2026-09-05 at06:45:58 UTC. Published tree `065c73a6fe52d5f88cfd2abe520e94fb2d1c9fb2` exactly matches accepted local `3351d411a316652c7d698be1583ffa23d6050da5`, verified by fetch and pinned diff. The object-storage job101264648438 executed all six original real-S3 cases and seven private local-store cases successfully after the connection-pooling correction; temporary diagnostics and automatic retries are absent. The postgres-bots job101264648426 passed identity8,ACL9,avatar8 in three separate commands. Compose job101264648429 passed fresh/upgrade through0014, exact object/reference and conversation grants, actual Alpine Sharp loading, private runtime-volume roundtrip/ownership and all previous application/outage checks. Code and all five PostgreSQL jobs also passed. This closes the avatar release gate on actual services; seventeen tickets are now fully complete.
