# COL-13 — Atomic Run concurrency limits implementation handoff

English contract for COL-13. Ticket ACs stay unchecked until Tester stamps native and Compose evidence.

## Authority

- Ticket: `issues/30-col-13-enforce-atomic-run-concurrency-limits.md`
- Blockers COL-11 and COL-12 are complete. COL-13 is in progress on `feat/openbot-collaboration-system`.
- Do not claim original ACs from this note.

## Slot measurement

- A Run occupies a slot only while it is `running` and its COL-11 lease is still live (`expires_at > now`).
- Completed, failed, paused, and cancelled Runs release their slots immediately.
- An expired lease releases its slot even if the Run row is still `running`. Recovery may later create a new queued attempt; that attempt occupies nothing until claimed.
- Workspace slots count live running Runs in that workspace.
- Group slots count live running Runs whose conversation belongs to that group. A group with no explicit cap uses four slots.
- Task child slots count live running Runs on descendant Tasks of that parent. The parent's own Run does not occupy its child cap.
- Direct (non-group) conversations have no group cap.

## Claim boundary

- Enforce slots at the centralized `claimNext` / finish boundary. A process-local semaphore does not prove the ACs.
- An excess Run stays `queued` and records the blocking layer (`workspace`, `group`, or `task`). It does not move to `waiting_budget`.
- If the oldest queued Run is blocked, skip it and try a later due candidate in the same claim so one full group cannot starve another.
- Do not add `GRANT UPDATE` on `execution_policy`. Do not rewrite COL-12 snapshots or usage.

## Original acceptance criteria (unchanged)

- Concurrent workers never exceed four running Runs for a default group.
- An excess Run remains queued and reports the policy level blocking it.
- A completed, failed, paused, or cancelled Run releases its slot.
- Task child-concurrency limits apply independently of Workspace and Group limits.
- Expired worker leases release their slots and cannot permanently block the queue.

## First slice

Pure policy and occupancy landed first. Claim wiring and hold persistence are now in product code; original AC boxes stay unchecked.

## Leftover before the original ACs can be stamped

- Native multi-worker claim, skip-blocked, and expired-lease slot release under `openbot_runtime`.
- Compose evidence that a default group never runs a fifth concurrent Bot.

Do not check the five AC boxes until Tester stamps those leftovers.
