---
sequence: 25
id: COL-08
title: "Pause and resume Tasks from checkpoints"
status: blocked
blocked_by:
  - COL-07
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

## Acceptance criteria

- [ ] Queued and running Tasks can be paused through the API and UI.
- [ ] A paused Task holds no execution slot and remains paused across restarts.
- [ ] Resume creates a new attempt without mutating the interrupted Run.
- [ ] Repeated pause or resume requests create no duplicate attempts.
- [ ] Partial output, checkpoint metadata, and transition history remain visible after resume.

## Non-goals

- Provider-native continuation
- Offline execution
- Automatic scheduling of paused Tasks
