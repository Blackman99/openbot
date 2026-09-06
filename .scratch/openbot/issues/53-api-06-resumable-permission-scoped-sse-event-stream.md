---
sequence: 53
id: API-06
title: "Resumable, permission-scoped SSE event stream"
status: complete
blocked_by:
  - API-01
  - COL-05
  - COL-07
  - COL-12
  - COL-19
labels:
  - area:api
  - area:realtime
  - kind:feature
  - priority:mvp
---

# API-06 — Resumable, permission-scoped SSE event stream

## Outcome

Web and external clients can subscribe to workspace and task events over SSE and safely recover after disconnection.

## Blocked by

- [API-01](48-api-01-scoped-api-token-lifecycle.md)
- [COL-05](22-col-05-stream-authorized-conversation-events-over-sse.md)
- [COL-07](24-col-07-cancel-task-trees-safely.md)
- [COL-12](29-col-12-enforce-hierarchical-execution-limits.md)
- [COL-19](36-col-19-pause-tasks-for-human-input-and-approval.md)

## Acceptance criteria

- [x] GET /v1/events accepts session or Bearer-header authentication and rejects tokens supplied in URLs.
- [x] Every event has a stable ID, and reconnecting with Last-Event-ID delivers unread events in original order.
- [x] A cursor older than the retention window returns an explicit cursor_expired error rather than silently losing events.
- [x] Tokens cannot observe events from other workspaces or unauthorized groups, and permission changes affect open streams immediately.
- [x] The stream includes task terminal, cancellation, approval, and budget-exhaustion events plus data-free heartbeats.
- [x] Slow consumers exceeding the backpressure limit are disconnected explicitly and can resume from their last confirmed event ID.

## Non-goals

- WebSocket protocol
- Infinite event retention
- Cross-instance event bus

## Discovered implementation dependencies

The existing fifth criterion requires actual cancellation, approval and budget-exhaustion events. COL-07, COL-12 and COL-19 supply those domain transitions; generic fixtures cannot substitute for their real producers. See [frontier handoff](../EXECUTION-FRONTIER-HANDOFF.md). These are implementation prerequisites for the approved criteria, not new criteria. All 67 tickets and 401 original acceptance texts remain unchanged.
