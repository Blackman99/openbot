# Avatar storage handoff

Recommended defaults for BOT-02, alongside BOT-CONTRACT and its immutable version-append handoff. The ticket's six acceptance criteria remain authoritative. Implement only after BOT-01 is integrated.

## Upload and display

- Accept static PNG and JPEG only, at most 2 MiB, no dimension above 4096 and no more than 4,194,304 decoded pixels. Require supported 8-bit content, actual signature/decoder agreement and full successful decoding. Reject animated content, including APNG, rather than trusting a filename or request Content-Type.
- Reencode to a metadata-free PNG within 512 by 512 pixels without enlargement. Bound decoder concurrency, queued work and the complete processing deadline; a library's processing timeout alone may not cover queued work. Use a maintained native decoder with a pinned package and verified deployment packaging.
- Browser uploads use multipart to the BFF, which sends bounded raw bytes to the API. Require trusted browser Origin before manufacturing the internal API Origin. Set the Web request-body limit to 3 MiB to accommodate a 2 MiB file and bounded multipart overhead; enforce the independent API/file limit as well.
- Mutation requests carry `expectedCurrentVersionId`. Check current workspace membership and Bot edit permission before expensive decoding, then check them again within the final version transaction. Upload, replace and remove append through the shared immutable-version operation; unchanged unavailable model bindings do not prohibit avatar-only edits.
- Render a deterministic Bot-ID-derived default when no avatar exists. Read an avatar through a same-origin Bot/version-authorized GET or HEAD, with private/no-store caching and nosniff. Current inspect permission protects uploaded avatar bytes; discovery-only viewers receive the deterministic default. Never return storage paths, public object URLs or presigned URLs as an authorization substitute.

## Storage and failure boundary

- Provide local private-volume and private S3-compatible adapters behind the same immutable save, bounded read and idempotent delete contract. Replacement creates a fresh internal random key; it never overwrites the previous object in place.
- Default local storage is `/var/lib/openbot/objects`, on an explicitly writable, runtime-owned named volume. Keep the API root filesystem read-only. S3 credentials and endpoint/bucket settings are operator configuration, never client-supplied object access. Use the official SDK with an exact dependency version selected at implementation time.
- Persist an upload intent before object I/O. Perform storage I/O outside Bot/database locks, then atomically publish the object reference, new version, current pointer, safe mandatory audit and cleanup candidates after fresh authorization/CAS. Upload or database failure preserves the previous avatar and pointer.
- Queue both superseded and unused staged objects for retryable cleanup. A superseded avatar may still be referenced by an immutable historical Bot version: retain it until there are zero retained-version references across all Bots. A cleanup candidate is not permission to delete a referenced object.
- Cleanup requires current reference/state checks and a bounded claim/lease, tolerates missing objects, retries storage failures and reconciles crashes around upload or publication. Coordinate reference publication and cleanup so restoration cannot acquire an object already being deleted. Soft deletion retains historical references until the later approved purge stage.
- Expose safe fixed errors and identifiers; do not log credential material, decoded image bodies or full object-store responses.

## Evidence

- Witness test-first failures for content masquerading, malformed/animated/oversized images, dimension/pixel bounds, unauthorized reads/writes, queued permission revocation, stale-version replacement, database/audit failure, retained historical references, cleanup retry and orphan recovery.
- Run one adapter contract against both local storage and a real S3-compatible service, covering save/read/replacement/deletion. A mocked SDK transport is useful unit evidence but cannot close the S3-compatible service gate.
- Actual PostgreSQL must prove version CAS, reference/cleanup locking and atomic rollback with the restricted runtime role. Deployment verification must prove native image-decoder loading and writable-volume ownership while preserving the read-only application filesystem. Record unavailable local services as explicit REL-01 evidence gates until actual CI passes.
