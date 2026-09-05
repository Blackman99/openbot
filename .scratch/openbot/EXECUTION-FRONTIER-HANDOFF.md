# API-06 event-producer dependency correction

Planning metadata only; no API-06 implementation or test completion is claimed.

The current stream batch is now accepted. All six dependency additions below and the public API handoff correction have been applied to the ticket metadata; the full 67-node graph remains acyclic and all 401 original acceptance texts are unchanged. The paragraphs below preserve the implementation rationale, not outstanding metadata work.

The original ticket 53 includes six unchanged acceptance criteria. Its fifth criterion requires actual task terminal, cancellation, approval and budget-exhaustion events. API-01 and COL-05 provide authentication and conversation delivery, but cannot supply the later approval and budget domain transitions.

After the current stream batch is accepted, add explicit API-06 prerequisites COL-07 (cancellation), COL-12 (budget warning/exhaustion/grant) and COL-19 (human request/decision). Keep API-01 and COL-05. This records the producers needed by the existing criterion; it does not add a feature or alter any of the 67 tickets' 401 original acceptance texts. Verify the complete dependency graph remains acyclic when applying the metadata update. Do not count fabricated generic event fixtures as end-to-end completion of missing producers.

API-06 still owns a real `/v1/events` session-or-Bearer stream, rejection of URL credentials, scoped stable ordered replay, explicit expired-cursor response, live current-token and resource admission, empty heartbeats and bounded backpressure. Reuse the reviewed COL-05 delivery and permission mechanisms where their scope matches; do not treat incomparable conversation sequence numbers as one workspace sequence. Its eventual workspace/task cursor and retention schema must be chosen against the actual merged domain producers, with no placeholder migrations.

Until those producers exist, API-06 remains blocked. Before accounting for the additional reuse edges below, accepting the pending COL-05/COL-06/COL-09/MEM-01 batch would unlock COL-07, COL-10, COL-11, MEM-02, MEM-03 and KNW-01. API-06 is removed from the apparently ready frontier rather than marked partially complete without its fifth criterion.

Also correct the stale opening sentence of `.scratch/openbot/PUBLIC-API-HANDOFF.md` when the next accepted metadata update is made: API-02 is already complete in Verify33960029570; API-03 remains dependent on the original group/routing/concurrency domain behavior. Preserve the existing public API authority and final transaction admission rules.

## Other approved implementation seams

The approved COL-11 handoff consumes COL-07's durable partial-output/cancellation fence and COL-10's shared persisted attempt chain, continuation writer and total automatic-run budget. Record explicit COL-07 and COL-10 prerequisites for COL-11 rather than implementing another partial table or an independent recovery budget. Its original five acceptance criteria remain unchanged.

The approved MEM-03 handoff consumes MEM-02's actual Bot-private memory storage, current-lineage admission and bound preview/confirmation writer for its required real Bot scope. Record MEM-02 as a MEM-03 implementation prerequisite. Candidate extraction still owns its job, exact Run input manifest, edited fact payload and group/Workspace scope; it does not count planned private storage as existing. Its original six acceptance criteria remain unchanged.

With these explicit reuse edges, the first post-batch work is COL-07, COL-10, MEM-02 and KNW-01. COL-11 follows the cancellation/attempt-chain source; MEM-03 follows the private-memory source. Existing in-progress pure Provider taxonomy and knowledge-extraction slices do not constitute completion of their whole tickets. Revalidate the entire graph when applying all edges.

Root evaluated all six proposed additional edges against the full 67-node current graph; it remains acyclic. No repository ticket or acceptance text was mutated by that planning check.
