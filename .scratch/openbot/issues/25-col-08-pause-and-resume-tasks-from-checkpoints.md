---
sequence: 25
id: COL-08
title: "Pause and resume Tasks from checkpoints"
status: complete
blocked_by:
  - COL-07
  - COL-10
labels:
  - area:collaboration
  - area:tasks
  - type:feature
  - mvp
---

# COL-08 — Pause and resume Tasks from checkpoints

## Outcome

Authorized users can pause queued or running work and resume it exactly once as a new immutable Run attempt.

## Blocked by

- [COL-07](24-col-07-cancel-task-trees-safely.md)
- [COL-10](27-col-10-add-bounded-retries-and-explicit-model-fallback.md)

## Acceptance criteria

- [x] Queued and running Tasks can be paused through the API and UI.
- [x] A paused Task holds no execution slot and remains paused across restarts.
- [x] Resume creates a new attempt without mutating the interrupted Run.
- [x] Repeated pause or resume requests create no duplicate attempts.
- [x] Partial output, checkpoint metadata, and transition history remain visible after resume.

## Non-goals

- Provider-native continuation
- Offline execution
- Automatic scheduling of paused Tasks

## Implementation coordination

The [approved pause/resume handoff](../COL-08-PREIMPLEMENTATION-HANDOFF.md) uses the single next-attempt writer owned by COL-10. The explicit COL-10 dependency prevents a second attempt allocator; it does not change the original five acceptance criteria or implement pause/resume.

## Implementation note

Pause covers queued and running Tasks, including a recursive subtree. Resume creates one new queued Run through `writeNextAttempt` with origin `manual_resume` and does not UPDATE the interrupted Run. Native `protect_task` / `protect_task_run` overlays admit those transitions under `openbot_runtime`. The UI exposes pause and resume forms and keeps interrupted output visible after resume.

## Completion evidence

Closed on 2026-09-06 against product HEAD `a6d24a2` with Tester PASS on [Verify 34002580880](https://github.com/Blackman99/openbot/actions/runs/34002580880) (all 17 jobs green). `postgres-tasks` executed queued pause, running pause, service resume, and group subtree pause/resume under `openbot_runtime`. `compose-task-pause` seed/pause/reloaded stages passed: queued pause before the worker starts, HTTP abort of a running request, resume as a new attempt, and interrupted output after restart. No local PostgreSQL or Docker execution is claimed. This does not implement COL-11 recovery.
