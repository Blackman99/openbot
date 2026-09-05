# Stream batch: routing projection delta

This is a root-approved integration adaptation on merge checkpoint `27d16d2260d8c64ea10123d5f35600e34d940e11`, after reviewed COL-05, COL-06 and COL-09 source was combined. It does not alter the original tickets or their acceptance criteria. At this checkpoint final MEM-01 incorporation, whole-candidate verification and independent integration reviews remained pending; their later completed evidence is recorded separately in `STREAM-BATCH-VERIFICATION.md`.

## Contract

`ExecutionState` permits one optional field: `routing: {algorithm: 'local-terms-v1', reason: 'mention' | 'default' | 'local-match'}`. It is the same immutable Task summary already exposed by COL-06. Existing frames without the field remain valid. No full routing candidate list, score, matched terms, Bot configuration or credential fields are included.

The transaction-owned Run projection reads only the two scalar fields from the Task's routing record, matching Task, workspace and conversation and requiring a group grant. The typed queued writer runs after the original decision insert in the same submission transaction. Later Run states and bootstrap use that same persisted decision; retry never recomputes it from current settings. Direct submissions reject caller-supplied routing and direct stream states omit it.

The outbound API encoder copies only the two allowed routing fields. The pure Web decoder accepts either the exact legacy ExecutionState grammar or that grammar plus a strictly validated summary. Malformed algorithms/reasons, null summaries and extra candidate fields are rejected. Bootstrap retains its existing aggregate byte/count limits and current-attempt projection. This adaptation allocates no new sequence, adds no migration and performs no additional HTTP request. Full routing evidence is still requested only after explicit selection of one Task.

## Witnessed regression

Before changing production source, `conversation-routing-stream.test.ts` failed because the first group bootstrap omitted the immutable routing summary. The direct compatibility case passed. The new Web contract case separately failed because the strict ExecutionState decoder rejected a valid summary; its 19 existing cases passed.

After the projection changes, both API cases and all 20 Web contract cases passed. The API regression submits a real group Task, checks the stored queued delivery, reconstructs the stream reader and resumes the same frame, fails the first Run, changes the group default, then retries the same Task. It proves the original local-match summary survives in the one current bootstrap attempt and all ordered running/failed/queued frames, with no missed or duplicate terminal cursor. A direct Task remains wire-compatible and cannot supply a forged summary. The Web regression accepts all three reasons in events/bootstrap, retains the legacy grammar, and rejects malformed or expanded summaries.

API and Web type checks passed with zero Svelte errors or warnings. The ten affected Web stream/routing/retry files passed all 141 cases. The thirteen affected API stream/routing/retry/Task files passed all 62 cases. These are local application/transport tests; no PostgreSQL, Docker, Compose or browser service was started for this delta.

## Independent review boundary

The exact delta `27d16d2260d8c64ea10123d5f35600e34d940e11..88b5d89503f596db2b40f4c2fd57b462fe94f037` received Spec CLEAN from the independent `batch_spec_review` agent and Standards CLEAN from root. Root reviewed the three production projections, the two API behavior cases and the strict Web case independently. The result covers the scoped immutable summary, strict legacy-compatible grammar, original queued/retried routing and absence of extra requests or allocation. It closes only this routing projection delta. The later MEM uncertain-command correction, full unified verification and final whole-candidate axes are documented in the separate final batch evidence.
