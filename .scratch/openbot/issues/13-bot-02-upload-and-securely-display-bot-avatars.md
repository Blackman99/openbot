---
sequence: 13
id: BOT-02
title: "Upload and securely display bot avatars"
status: blocked
blocked_by:
  - BOT-01
labels:
  - bot
  - files
  - object-storage
  - vertical-slice
  - mvp
---

# BOT-02 — Upload and securely display bot avatars

## Outcome

Bot owners and editors can upload, replace, and remove avatars through a shared local or S3-compatible object-storage abstraction.

## Blocked by

- [BOT-01](12-bot-01-create-and-inspect-a-persistent-bot-identity.md)

## Acceptance criteria

- [ ] Users with edit access can upload, replace, and remove avatars within supported format and size limits.
- [ ] The server validates actual file content and dimensions rather than trusting extensions or client Content-Type.
- [ ] Bot list and detail views show the avatar, with a stable bot-ID-derived default when none exists.
- [ ] Private avatar reads enforce the bot ACL, and direct object URLs cannot bypass authorization.
- [ ] Upload or database failure preserves the previous avatar; successful replacement queues the old object for retryable cleanup.
- [ ] Local and S3-compatible backends pass the same save, read, replace, and delete contract tests.

## Non-goals

- General attachment ingestion or knowledge extraction
- An image-cropping editor
- Public CDN configuration
