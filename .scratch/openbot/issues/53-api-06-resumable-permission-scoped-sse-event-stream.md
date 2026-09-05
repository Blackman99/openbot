---
sequence: 53
id: API-06
title: "Resumable, permission-scoped SSE event stream"
status: blocked
blocked_by:
  - API-01
  - COL-05
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

## Acceptance criteria

- [ ] GET /v1/events accepts session or Bearer-header authentication and rejects tokens supplied in URLs.
- [ ] Every event has a stable ID, and reconnecting with Last-Event-ID delivers unread events in original order.
- [ ] A cursor older than the retention window returns an explicit cursor_expired error rather than silently losing events.
- [ ] Tokens cannot observe events from other workspaces or unauthorized groups, and permission changes affect open streams immediately.
- [ ] The stream includes task terminal, cancellation, approval, and budget-exhaustion events plus data-free heartbeats.
- [ ] Slow consumers exceeding the backpressure limit are disconnected explicitly and can resume from their last confirmed event ID.

## Non-goals

- WebSocket protocol
- Infinite event retention
- Cross-instance event bus
