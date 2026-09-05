# Group Bot membership and history handoff

Recommended implementation decisions for COL-02, consuming accepted COL-03 and BOT-04. These are not yet implemented.

## Membership and current authority

- Adding requires current group management and direct Bot use; removal requires current group management. Group roles never grant direct Bot configuration, ACL, copy or avatar-inspection rights. Group displays use safe metadata and the default avatar unless the viewer separately has inspect permission.
- Record each grant's stable ID, group/Bot/conversation IDs, granting human, join event/sequence, lower history boundary and optional closure event/sequence. Retain closed grants. Allow only one active grant for a group/Bot and eight active Bots by default; reject a ninth with a stable machine-readable limit error without mutation.
- Every indirect use/context admission checks the requesting human's current workspace/group access, the active grant, and the grantor's current workspace membership/direct Bot use. Provider authorization belongs to the actual requesting human, not the grantor's credentials.
- In the same transaction as grantor Bot-ACL revocation or workspace removal, permanently close affected group grants and append closure events/audits. Receiving a new ACL or rejoining cannot reopen them. A later explicit invitation creates a new grant; queued work pinned to an old grant cannot switch automatically.
- Losing a grantor's group-management role alone does not erase an otherwise explicit grant. Removing that Bot remains a current group-management action. Closing grants during workspace removal does not grant the administrator any direct Bot ACL/edit permission.

## Shared ledger and history

- Use the single COL-03 ledger and private sequence allocator through a typed membership append. Add the next ordered migration for non-message event identity constraints and grant tables; preserve published0014. Do not expose allocation without the corresponding typed event and required audit.
- Admission, get-or-create group conversation, sequence/event, grant change and required audits share one caller-owned SQL transaction. A failed invitation must not leave an independently committed conversation/grant/event. Lock workspace, groups in stable order, Bot, then conversation; use the BOT-CONTRACT revocation entry-point ordering.
- Omitted history means future-only at the join event. Since-event must reference the same conversation; since-time resolves once to a conversation sequence under admission. All-history requires an explicit choice. Persist the resolved boundary, not a moving timestamp filter.
- A new grant never implicitly unions older grants or opens the removal interval. Explicit since/all choices may authorize wider history. Inactive grants do not admit new use or model context.
- Test each message's original creation against the active lower boundary before choosing its permitted current version. Later edits cannot reveal pre-grant messages; tombstones and current permissions still apply. Non-message membership events share sequence order but must not masquerade as human messages.

## Vertical slice and evidence

- Implement group UI for adding/removing Bots, history choice and limit/current-permission feedback, plus a real admitted context-projection seam for COL-04. Do not fabricate Task/Run execution or duplicate conversation storage to demonstrate the feature.
- Reuse the existing strict BFF behavior: exact Origin, body-only JSON headers, current identity errors, bounded response decoding, safe DTOs and recoverable unknown outcomes.
- Native PostgreSQL must prove concurrent cap/duplicate admission, atomic grant/event/audit rollback and both orderings of revocation. Cover default/since/all bounds, removal/reinvite, creation-before-late-edit, workspace/Bot permission separation and stable retained provenance. Record local skips as a REL-01 gate; actual CI must execute them.
