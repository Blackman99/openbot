---
sequence: 16
id: BOT-05
title: "Safely copy a bot configuration"
status: complete-with-external-verification
blocked_by:
  - BOT-03
  - BOT-04
labels:
  - bot
  - copy
  - security
  - vertical-slice
  - mvp
---

# BOT-05 — Safely copy a bot configuration

## Outcome

Authorized users can preview and copy the current configuration into a new private bot without copying credentials, ACLs, history, or memory.

## Blocked by

- [BOT-03](14-bot-03-edit-compare-and-restore-bot-versions.md)
- [BOT-04](15-bot-04-grant-bot-owner-editor-and-user-permissions.md)

## Acceptance criteria

- [x] A member with bot user access or higher can open a preview that explicitly lists included and excluded fields.
- [x] Confirming the copy creates a new stable bot ID and version 1, with the actor as sole owner.
- [x] The copy includes only reviewable identity, instructions, execution limits, and permitted avatar references; it excludes ACLs, credentials, history, memory, file contents, and audits.
- [x] If the actor cannot use the source model, confirmation requires selecting an accessible replacement model.
- [x] Cancellation or validation failure creates no bot, version, ACL, or orphaned object.
- [x] Automated tests scan responses and new records for connection keys or sensitive headers and verify the copy audit event.

## Non-goals

- Cross-workspace template import or export
- Copying conversation history or memory
- A public bot marketplace

## Implementation handoff

Follow [BOT-COPY-LIFECYCLE-HANDOFF](../BOT-COPY-LIFECYCLE-HANDOFF.md). BOT-03 is integrated; its remaining native evidence stays explicit in REL-01.

## Author implementation and pending acceptance

The copy preview/confirmation API, transactional domain operation, strict BFF and review UI are implemented. Confirmation rechecks direct Bot access, membership, source version, source lifecycle and actual-actor model admission. Copies are fresh private active identities with version1 and only the actor owner. Avatar references are reused only through the freshly authorized retained-version/live-object boundary; public raw object IDs remain rejected, and later copied edits/restores/cleanup preserve the reference rules.

The author incorporated the BOT-06 core checkpoint to implement and test archived-copy/deleted-source behavior. Full BOT-06 acceptance remains a publication dependency. Independent Standards and Specification review plus the dedicated additive merge are still required before this ticket's status becomes complete.

See [BOT-05-CONTRACT](../BOT-05-CONTRACT.md), [BOT-05-VERIFICATION](../BOT-05-VERIFICATION.md), and [BOT-05-NATIVE-EVIDENCE](../BOT-05-NATIVE-EVIDENCE.md). The native suite defines17 restricted-role concurrency/rollback cases and is wired sequentially into CI; local discovery skipped them because PostgreSQL is unavailable. The actual native CI gate is explicitly open.

Author final repository gate passed931 unit/integration tests,30 ordinary browser scenarios, one signed-OIDC journey, formatting, both typechecks and both builds. Shared test ports were confirmed closed and released. This is author evidence, not independent review or publication acceptance.

## Accepted integration and remaining service evidence

Copy-only source4257bdf was independently CLEAN on Standards and Spec against c389f993, then integrated as0d641dba after accepted full BOT-06. The dedicated combined pnpm verify passed969 unit/integration tests,32 ordinary browser scenarios, one signed-OIDC journey, formatting, types and both builds. Root independently reviewed the two small integration resolutions. Native17 cases remain explicit BOT-05-E1 in REL-01; local discovery/skips do not close that gate.
