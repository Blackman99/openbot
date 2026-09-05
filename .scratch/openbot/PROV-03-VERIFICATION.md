# PROV-03 verification and handoff

The implementation supports explicit `openai-chat` and `openai-responses` connections.
The connection service persists the protocol in existing JSON metadata; repository reads default
legacy records to Chat. No schema migration is needed. Production dispatch, the strict web decoder,
settings create/edit controls, and the browser fixture all carry the explicit selection.

## Model execution seam

- `model-events.ts`: `ModelAdapter.generate(input, signal?, onEvent?)` returns actual normalized
  text/action/usage/completion events and a classified error. `onEvent` runs before EOF for streams
  and accepts an awaited promise, allowing later collaboration consumers to apply backpressure.
- `transport.ts`: `PinnedProviderTransport.send` owns the validated, DNS-pinned HTTP connection,
  bounded response, incremental UTF-8 decoding, no redirects/proxies, and cancellation.
- `model-request.ts`: shared total request deadline, safe status/error classification, sanitized
  raw diagnostics, and consumer cancellation. Event text and action arguments preserve actual model
  output semantics; they are content, not diagnostics. Probe/API evidence includes only redacted raw
  output and stable codes, never the model event payloads or upstream error messages.
- `model-probe.ts`: `ModelConnectionProbe` executes real text and structured-function probes through
  a supplied adapter with a single 15-second total deadline. Existing Chat probe exports remain
  compatible. No capability is inferred from an endpoint name or hard-coded success response.
- `openai-chat.ts` and `openai-responses.ts` normalize plain JSON and typed/SSE streams. Responses
  accumulates each function call independently and avoids re-emitting final snapshots. Successful
  completion requires a protocol terminal marker; EOF alone is an interruption.
- `protocols.ts`: `createModelAdapter` and `ProtocolConnectionProbe` are the explicit dispatch seams
  for the PROV-04 integration owner. Shared files have been coordinated with that implementer.

## Red/green evidence

Baseline: 52 API unit + 56 API integration + 8 web unit + 29 web integration tests passed, together
with typechecks. New adapter/probe module scaffolding initially reported missing modules; those
scaffolding failures are not claimed as behavioral red evidence.

Witnessed behavioral red then green:

- Live Responses delivery failed the before-EOF assertion; incremental decoding made it pass.
- Interleaved function calls returned only completion; normalized independent actions made it pass.
- Streamed rate-limit/server/authentication/unsupported errors were incorrectly all interruptions;
  fixed code classification made the four cases pass.
- Cancellation from a waiting event consumer exposed an unhandled rejection; consuming already
  aborted pending promises eliminated it without losing cancellation.
- Chat SSE returned an invalid JSON response; the shared Chat event decoder made it pass.
- Saving explicit Responses omitted protocol; persistence, compatibility default, and updates passed
  after adding the metadata field.
- Settings dropped the protocol form value and rendered no select; server forwarding and the UI
  selector made both assertions pass.

Regression coverage also includes malformed action JSON, split UTF-8/SSE, unknown events,
unsupported action capability with working text, HTTP errors, response caps, DNS timeout, aborted
consumers, request secrets in error bodies, original Chat probe behavior, owner isolation,
optimistic revisions, and API/UI credential masks.

## Initial candidate verification

- Full formatting, typechecks, all 167 tests (API 52 unit + 78 integration; Web 8 unit + 29 integration),
  and serial API/web production builds passed. Svelte reported 0 errors and 0 warnings; existing
  generated-empty-chunk/build-timing notices remain. Browser selection/reload/edit regression is authored.
- All 6 browser scenarios passed on the root-granted exclusive lease, including Responses selection,
  save, reload, retained selection, and editing back to Chat. The lease is released.
- Independent review results and fixes are recorded below against their pinned code revisions.
- Actual PostgreSQL/Compose execution remains external evidence. The existing provider runtime
  test now asserts Responses protocol round-trip in encrypted owner-scoped storage. Run the
  combined `postgres-providers`, `postgres-auth`, and Compose CI jobs before release acceptance.

## Cross-adapter review fix

The PROV-04 implementer identified that a valid probe action with a truncated completion reason
could incorrectly pass. A live Chat mock returned `finish_reason: length`; the new regression failed
with `ok: true` before the fix. Shared probe success now also requires terminal `tool_calls` or
`tool_use`. The regression and all Chat/Responses adapter cases pass after the fix, together with
API typecheck and production build. That checkpoint contains 168 unit/integration tests.

## Standards review fixes

Independent standards review identified two P2 findings against `a855726`:

- `transport.ts` conflated the probe diagnostic cap with the entire generated response budget.
  A legitimate 500-delta stream failed after 474 events. The regression reproduced this before the
  fix. Ordinary generation now allows up to 8 MiB of wire data; callers can choose a smaller internal
  `maxResponseBytes` budget. Returned diagnostics stay capped at 65,536 bytes and probes retain their
  original 65,536-byte wire cap. The lower probe cap and upper generation cap are both tested.
- `sse.ts` rejected CR-only line endings and treated a trailing comment as incomplete data. The
  three-case line-ending/comment regression failed before line-oriented parsing was added. It now
  accepts CR, LF, and CRLF including CRLF split across reads, and ignores comments, following
  [WHATWG SSE sections 9.2.5–9.2.6](https://html.spec.whatwg.org/multipage/server-sent-events.html#parsing-an-event-stream).

The affected Chat/Responses/probe contract tests total 36 and passed with API typecheck. Independent
Standards recheck at `271aa4a2053767adef428ab5d93e46ebf6e357fb` reported no unresolved P0–P3
findings. The reviewer reproduced the three original failures as green, checked a 100K nonstream
response retains complete model text with bounded diagnostics, and verified every two-chunk split
of CR/LF/CRLF SSE inputs. The reviewer also ran all 36 contract tests independently.

## Spec review

Independent Spec review of `f5a5c71...977b949` reported no actionable findings across all six
acceptance criteria. The reviewer independently ran 37 focused adapter/probe/persistence tests,
including the completion-stop fix. The root relayed this completed review when messaging the
reviewer hit the agent-thread limit; no missing review is represented as successful.

After the standards fixes, all 172 unit/integration tests passed (API 52 unit + 83 integration;
Web 8 unit + 29 integration), together with formatting, types, and the API build. Web production
build and all 6 browser scenarios passed on the earlier candidate and are unchanged by these
transport-only fixes. Both review axes are clean at `271aa4a2053767adef428ab5d93e46ebf6e357fb`.

The independent affected Spec recheck of `977b949...271aa4a` examined all seven changed files and
reported no acceptance-criteria regressions or scope expansion. It confirmed the budget split,
probe/diagnostic bounds, live callbacks, cancellation, completion, and error contracts remain
intact. The reviewer inspected the exact delta and regressions without repeating already-green
browser checks. No independent review remains missing.

## Remaining external gate

`PROV-03-E1` in REL-01 requires real `postgres-providers`, `postgres-auth`, and Compose checks on
the combined PROV-03 revision. Local mocks and pg-mem do not stand in for that evidence. Prior
PROV-01 and WS-02 successful CI does not close this later provider revision's gate.
