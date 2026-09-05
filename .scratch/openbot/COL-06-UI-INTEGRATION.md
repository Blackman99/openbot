# COL-06 selected routing UI integration

Development checkpoint on actual0021 core1fd4a5e and the independently reviewed
Web helper76047c0 (locally imported as1dce88e). This remains outside the accepted
root/public snapshot pending browser, native and whole-ticket review gates.

## User path

The group Task form defaults to automatic routing. Its optional `Mention a Bot`
control binds an exact retained grant and displays explicit choices as `@ Name`.
An uncertain submission preserves the same empty or explicit choice and command
key. A known no-eligible-Bot error preserves the draft and permits correction.

Every routed Task summary shows the selection reason and a `Why this Bot?` link
into its conversation. `?routingTaskId=<Task UUID>#routing-<Task UUID>` loads exactly
one already-admitted Task and one bounded safe decision, without expanding a Task
list. The conversation retains its ordinary messages and displays the saved Lead,
reason and expandable evidence. Task detail shows the same decision; group and
conversation navigation expose routing settings.

Full-decision loading verifies the selected Bot ID, version ID, exact grant and
pinned name against the separately admitted Task. A valid receipt for a different
pinned target is rejected. Invalid/duplicate selected IDs are rejected before Task
content reads. Current permission denial on the later decision read fails closed
without pretending that the user logged out. An ordinary conversation request
issues no extra Task/decision calls. Old/direct Tasks with no receipt remain readable.

## Verification

- Witnessed seven failing selected-page cases (plus one unchanged baseline pass):
  missing conversation/detail evidence, malformed selected IDs, mismatched pinned
  target and later permission denial. All eight pass after implementation.
- Witnessed three SSR failures for absent optional mention and evidence views;
  all three pass. Related Task/conversation SSR13 and boundary/client55 pass.
- Entire Web unit105 and integration635 pass. Types report zero errors/warnings;
  Web build and repository formatting pass.
- Actual Fastify/domain routing and direct-Task Web-contract files:15 pass,
  including real automatic submission/replay and exact full-decision decode.
- Existing Task browser selectors were updated to the precise optional-mention
  label. Real browser acceptance has not run for this snapshot yet. Four journeys
  are being prepared separately against production API/domain services.

No local native PostgreSQL/Compose pass is asserted. Real0021 native assertions,
final COL05/MEM/COL09 dependency composition, browser evidence and both independent
whole-ticket axes remain required. Original six COL06 acceptance criteria and all
67 tickets/401 original criteria are unchanged.
