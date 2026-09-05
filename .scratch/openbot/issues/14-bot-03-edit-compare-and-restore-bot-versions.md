---
sequence: 14
id: BOT-03
title: 'Edit, compare, and restore bot versions'
status: complete
blocked_by:
  - BOT-01
  - BOT-02
labels:
  - bot
  - versioning
  - vertical-slice
  - mvp
---

# BOT-03 — Edit, compare, and restore bot versions

## Outcome

Every bot configuration change creates an immutable version, and authorized users can inspect differences and restore prior configurations through a new version.

## Blocked by

- [BOT-01](12-bot-01-create-and-inspect-a-persistent-bot-identity.md)
- [BOT-02](13-bot-02-upload-and-securely-display-bot-avatars.md)

## Acceptance criteria

- [x] Editing configuration or avatar references atomically creates a new version and advances the current pointer without overwriting prior records.
- [x] Updates require a current version or ETag; stale concurrent writes return HTTP 409 without losing committed versions.
- [x] The version view lists author, time, and rationale and shows field-level differences for identity, instructions, model, avatar, and limits.
- [x] Restoring a prior version creates a new current version without deleting, renumbering, or modifying history.
- [x] Editing or restoring a model binding revalidates the user's access to the target connection and model.
- [x] Integration and Playwright tests cover version creation, conflicts, and restoration, with an audit event for every successful change.

## Non-goals

- Editing chat-history or memory versions
- Git-style branching or merging
- Copying versions across workspaces

## Implementation and review handoff

All six acceptance criteria are implemented in isolated `ticket/bot-03` from base `f0f9383fd299873134f332962d4c14f55b38fdd8`. Source candidate `a49413b010498a2309304c9a4798374bbf1fa46f` passed complete local verification: 759 unit/integration tests, 21 ordinary Chromium journeys, one signed OIDC journey, formatting, types and production builds. Both independent Standards and Specification reviews are CLEAN on that exact source candidate; the Specification reviewer additionally ran 18 focused API tests. See [BOT-03-CONTRACT](../BOT-03-CONTRACT.md) and [BOT-03-VERIFICATION](../BOT-03-VERIFICATION.md).

Dedicated merged verification and actual CI remain pending. The new restricted-role PostgreSQL file defines 11 cases, all explicitly skipped locally because TEST_BOT_DATABASE_URL is absent. No native PostgreSQL, real S3 or Compose success is claimed here, and no schema migration or grant expansion was introduced. The existing service jobs remain intact; Bot native files run as four separate serial commands.

## Accepted integration

BOT-03 integrated as `82d5d911fdcf1e7a9f17b62023f776fd694246af`, tree `ddd5bea851c863d1f95718da5b363ac399f0f4de`. Both independent review axes are CLEAN at source `a49413b010498a2309304c9a4798374bbf1fa46f`; author final `6192dd3585e730192081de4bcde4174941d81f6c` changes only ticket/evidence documents. Dedicated merged pnpm verify exited0 with813 unit/integration tests (API88+289,Web47+389),24 ordinary browsers and one signed-OIDC journey,formatting,zero-error/zero-warning types and both builds. Root independently reviewed the four shared integration files: additive version service/routes, fourth serial native command and browser fixture;26 other candidate paths match exactly. No new domain correction was required. The11 actual PostgreSQL version cases remain BOT-03-E1 in REL-01 pending CI; local skips are not execution.

## Actual external gate closure

BOT-03-E1 is closed by [Verify33956965487](https://github.com/Blackman99/openbot/actions/runs/33956965487), completed 2026-09-05 at09:07:34 UTC with all nine jobs successful. Actual native and Compose execution is recorded in [the service evidence](../VERIFY-33956965487.md). The tested tree exactly matches the accepted published candidate. This supersedes earlier pending/native-skip notes.
