---
sequence: 45
id: IMG-01
title: "Send authorized image attachments to vision-capable models"
status: in-progress
blocked_by:
  - ATT-01
  - RET-01
  - PROV-05
labels:
  - feature
  - area:attachments
  - area:providers
  - mvp
---

# IMG-01 — Send authorized image attachments to vision-capable models

## Outcome

Conversation and knowledge images are delivered only to endpoints that advertise compatible vision capability, with explicit fallback behavior and no fabricated OCR or captions.

## Blocked by

- [ATT-01](41-att-01-upload-view-and-download-conversation-attachments-with-history-aw.md)
- [RET-01](43-ret-01-assemble-a-permission-aware-provenance-preserving-model-context.md)
- [PROV-05](11-prov-05-manage-capabilities-overrides-and-compatible-fallback-chains.md)

## Acceptance criteria

- [ ] An authorized image attached to the current message is included in the request to a model whose resolved capability catalog includes vision input.
- [ ] A run targeting a non-vision model fails before provider invocation with a visible capability error rather than silently dropping the image.
- [ ] Promoting an image to knowledge requires an authorized user to supply and confirm a searchable title and description.
- [ ] When retrieval selects promoted image knowledge, the original image is attached only for a vision-capable target; other targets receive only the confirmed description.
- [ ] No OCR text or generated description is stored unless a distinct user-confirmed extraction action created it.
- [ ] Image metadata, bytes, and references obey the same scope, history grant, version, and tombstone checks as their source attachment.

## Discovered implementation dependencies

Claim reads authorized PNG/JPEG attachments on the trigger message or the immediately previous user message, then checks the resolved `visionInput` catalog before calling a provider. Vision-capable targets receive original bytes on the protocol payload; non-vision targets fail the run with `model_unavailable` instead of dropping the image. Image knowledge stores only a user-confirmed title and description (`image-description-v1`); retrieval attaches the original file only when the target supports vision. These notes do not change the original acceptance texts, which stay unchecked.

## Non-goals

- Automatic OCR
- Automatic image captioning
- Image generation or editing
- Image embeddings
