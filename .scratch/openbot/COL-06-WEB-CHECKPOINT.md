# COL-06 Web author checkpoint

Base: `66347c55d32eb0e1fd2806433476c36701ea9d6a`.
Source-only staged tree: `52732e2d495fa113ea87829cd2ae867fa6ddbdb5`.
The checkpoint adds 15 Web source/test files plus this evidence note. No existing
Conversation page, TaskSummary, tasks client, fixture API, schema, or root ticket
metadata was changed.

## Boundaries implemented

- Independent `/app/workspaces/:workspaceId/groups/:groupId/routing` page with
  current member inspection, owner/admin default setting and explicit clearing.
  Defaults retain exact grant identity, including closed grants; a reinvitation
  is never silently selected. Existing public membership reads supply choices;
  direct Bot configuration and provider calls are unnecessary.
- Strict settings GET/PATCH client, canonical scoped UUIDs, exact public DTO,
  expectedRevision CAS, same-revision no-op and next-revision receipts. Writes
  require the returned manager permission and exact requested nonclosed grant or
  explicit null. Model outage permits clearing. Conflict/unknown outcome keeps
  the original revision and choices, disables mutation controls and asks for a
  refresh. The API remains the final current permission boundary.
- A pure `local-terms-v1` decision decoder and independently renderable
  `RoutingDecision.svelte`. The decoder accepts exact lead/candidate public
  persona projections, 1–8 unique ordered Bot/grant/version identities and a lead
  identical to a candidate. It validates sorted unique matched terms against
  each public field's actual NFKC/lowercase words and Han bigrams, with per-field
  set weights 3/4/1 accumulated across fields. Local winners obey score/UUID ties;
  explicit mentions and eligible defaults may choose lower scores.
- `RoutingDecisionApiClient.getForTask` performs no fetch when the already
  admitted Task has no routing summary. Otherwise it fetches the one scoped
  receipt, validates the exact `{routing:decision}` envelope and summary
  agreement. Shared Task/Conversation integration remains with the parent task.
- Settings and error bodies are limited to 16 KiB; full decisions to 1 MiB.
  Reads count streaming bytes, reject invalid UTF-8/advertised oversize, cancel
  rejected or stalled bodies, and retain a 30-second deadline through body
  consumption. External cancellation propagates. Only actual HTTP 401 maps to
  anonymous; wrong status/code pairs and private extra keys fail closed.
- Settings POST bodies accept only the two URL-encoded fields, reject duplicate
  or forged values, and stop after 4 KiB. Origin and no-store boundaries are
  preserved. SvelteKit's `?/update` marker is accepted during the page load after
  a failed named action; unrelated query fields are rejected.

## Witnessed verification

2026-09-05 UTC, isolated worktree `.worktrees/col-06-web`:

- Settings client's first valid read/CAS test failed against the unavailable
  stub, then passed after implementation.
- Decision parser had four valid-receipt failures against the undefined stub;
  decoder implementation passed all 24 positive/negative parser cases.
- Decision client had five failures against its unavailable stub, then passed
  its 11 boundary tests.
- Page boundary's initial 12 cases failed against the 503 stub, then passed.
  A subsequent named-action-load test independently reproduced HTTP 400 and
  passed after accepting only the exact SvelteKit marker.
- All nine SSR behavior/escaping tests failed against the empty page/component,
  then passed. Assertions distinguish actual anchor elements from `<article>`
  and allow Svelte's valid boolean-attribute/CSS serialization.
- Advertised oversize cancellation separately failed with zero cancel calls;
  moving validation inside the reader's cleanup boundary made it pass.
- Actual API `chooseLead` is imported by three pure integration cases covering
  mention/default/local-match, eight candidates, maximum 100/200/2000-character
  public fields, NFKC-expanding text and over 2,000 matched terms per candidate.
  Every full receipt fits the byte limit and passes the Web client decoder.
- Final focused gate: **6 files, 92 tests passed** (33 unit/SSR, 59 integration).
- Final `svelte-kit sync && svelte-check`: **0 errors, 0 warnings**.
- New TypeScript files formatted with repository Prettier; staged diff check clean.

No browser or service was started. No real PostgreSQL, S3 or Compose execution
was claimed. This is an author checkpoint, not an independent COL-06 approval or
ticket completion; full integration, browser coverage and both independent
review axes remain required.
