# COL-06 deterministic group routing contract

Original ticket23 and its six acceptance criteria remain authoritative. The isolated
branch starts at accepted COL-04 cb997737. Standalone matcher/schema fixtures may
be implemented before dependencies arrive; migration0021 is reserved after actual
ATT0018, COL050019 and MEM010020. No placeholder or rewrite of earlier migrations.

## Choosing one Lead

The existing Task submission remains one atomic human trigger, Task and first Run.
In a group, an explicit `groupGrantId` now means a structured Bot mention. The UI
labels the optional control `Mention a Bot` and displays the selected Bot as an
explicit @ mention. It binds the retained grant ID, never an ambiguous display name.
Omitting it asks for automatic routing. Direct Task submission is unchanged.

Selection order is explicit admitted mention, eligible configured default grant,
then the deterministic local matcher. An unavailable explicit mention fails safely;
it never sends the prompt to another Bot. An unavailable/closed default falls back
to local matching. No eligible candidate yields a fixed machine-readable error and
no committed trigger/Task/Run. The configured default is a retained grant ID; a
replacement invitation does not silently inherit it.

Candidates must pass current requesting-human workspace/group access, exact active
group grant, current grantor workspace/direct Bot-use rights, active Bot lifecycle,
and actual requesting-human model-use admission with verified Basic text/streaming
capability and the pinned model identity. Basic remains sufficient for this single
Lead invocation; reliable delegation capability remains a later delegation check.
Removed, archived/deleted, disabled, inaccessible and incompatible bindings cannot
win. Unexpected database errors propagate rather than becoming empty candidates.
Checks read local persisted capability evidence and make no provider/network request.

The versioned `local-terms-v1` matcher uses only admitted public name, roleDescription
and description. NFKC/lowercase words and Han bigrams are matched locally; repeated
terms have no extra weight. Name/role/description matches score3/4/1. Candidate output
is ordered by stable Bot UUID; equal scores select the smallest UUID. These integer
scores explain lexical suitability, not confidence or a calibrated probability.
Instructions, private memory, credentials, model binding IDs and raw provider errors
never enter the candidate evidence. Matchers explicitly project allowed fields.

## Default setting and decision receipts

Group members may read the current routing setting; only current group owner/admin
may change it. Use a separate scoped settings row with revision, optional grant ID,
editor and time. PATCH has an expectedRevision and a nullable defaultGrantId. Setting
a default requires that exact currently active group grant and current model use;
clearing remains possible during model outages. CAS failure is a fixed409. Mutation
and mandatory content-free audit are atomic. Default changes do not alter queued
Tasks or historic decisions.

Persist one immutable routing decision with each new routed group Task: Task/group/
conversation identity, algorithm, selected pinned Bot/version/grant, reason and a
bounded list of admitted public candidate evidence. Store a separate normalized
request fingerprint distinguishing explicit mention from automatic routing. Retain
the existing Task/trigger command hash of the actual selected grant, preserving0017
identity guards and attachment purge boundaries. No additional human message or
allocation-only conversation event is introduced.

Replay first locates the existing command under current group admission and the
workspace lock. Compare the original request fingerprint; reauthorize its stored
grant, pinned Bot version and actual human model rights. Return its original Task
and decision without rerouting when defaults, names or candidate order change.
Changed input conflicts. Old explicit-grant Tasks without a routing receipt keep
their existing command-hash replay semantics. A current default never revives an
old closed grant. Native concurrent submissions must produce exactly one Task,
trigger, first Run, decision and each mandatory audit.

## Lock and module boundaries

All work borrows the Task transaction. Lock workspace then group; enumerate at most
eight active grant Bot IDs, acquire all Bot locks in stable order, and only then lock
the group conversation. Admit targets and provider scopes after the corresponding
structural locks; personal model scope belongs only to the requesting human and a
workspace binding belongs to this workspace. Do not loop Bot→conversation→next Bot
without prelocking the complete Bot set. Group/ACL/provider writers share these locks.

Read-only setting/receipt inspection requires current group/conversation content
rights, not current historic provider availability or the selected grant still being
active. Safe public candidate metadata is historical evidence; it cannot authorize
new execution. Task views expose only an optional bounded routing summary {algorithm,reason};
the Task ID identifies its decision. Direct and pre-routing Tasks have none.
GET .../tasks/:taskId/routing returns the full safe decision and bounded candidates
under current conversation inspection. Do not multiply full persona/match evidence
across a20-Task list payload. Conversation evidence is loaded for one selected
Task at a time; every stored candidate remains available for inspection. Conversation and Task detail display the Lead,
selection reason and expandable candidate scores/matched terms. Setting controls
are available from the group; member views omit management controls.

Use the COL05 typed queued Run state writer for the existing Task transition and
its single conversation sequence. Routing creates no independent SSE namespace.
COL09 retries preserve the initial decision and pinned target; they do not reroute.
MEM source selectors and Run manifests are unchanged. API03 later reuses this same
submission service rather than a second router or a provider-backed routing call.

## Verification

Witness RED→GREEN for mention precedence, eligible default, stable local tie/match,
Chinese/fullwidth input and private-field exclusion. Integration tests exercise real
group admission and model capability exclusions, explicit-denial/no-fallback, default
CAS, atomic decision/audits, automatic replay after default changes and readback after
restart. Assert no adapter/probe invocation during routing and exactly one provider
call from the separately claimed Run. Browser covers default/mention/local decisions
and visible evidence. Native cases prove waiting revocation, concurrent receipts,
audit rollback, same-scope references and immutable/restricted rows. Local native
skips never close the actual PostgreSQL/Compose gate. Both independent review axes
and dedicated integration are required before ticket completion.
