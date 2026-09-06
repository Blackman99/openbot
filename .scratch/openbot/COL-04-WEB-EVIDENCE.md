# COL-04 Web implementation checkpoint

This worktree owns the Task BFF, safe DTO decoder, list/detail pages and additive Bot message author UI. API/worker/schema/native ownership remains in the separate COL-04 core worktree. This checkpoint is not full ticket acceptance.

Witnessed test-first slices:

- A queued submission initially returned unavailable; the client now sends one exact Task command and accepts the202 receipt.
- An oversized otherwise-valid response initially passed; streamed byte limits now reject it.
- Running/completed/failed persisted Task reads initially failed; strict list/detail decoders now retain the actual model, attempt and cumulative usage.
- A stalled response body initially ignored the30-second deadline; cancellation now ends body consumption. Separate RED cases for an already-aborted page and an in-flight page disconnect are GREEN.
- Group Task page loading initially returned503; it now reads persisted tasks and current exact grants without requiring direct Bot configuration access. Task pagination is not passed into conversation-message pagination.
- An ambiguous submission initially lost its command; the BFF now preserves exact key, prompt and grant and redirects unchanged replay to the saved Task. Origin, forged/duplicate fields, query bounds,401-only logout and safe conflict/error cases are covered.
- Saved Task detail initially returned503; it now reads without re-admitting an old grant or looking up a model connection.
- Three SSR cases initially rendered only empty headings; they now show persisted status/attempt/model/usage, explicit group selection, and frozen unchanged replay after an uncertain result.
- Bot output author decoding and rendering started RED and now preserve pinned Bot/version authorship while rejecting human edit/delete/audit controls.

The actual lifecycle baseline and final API/worker/native candidate03d8091 are integrated. Two additional REDs showed archived/deleted group Bots still selectable for new tasks; filtering to active, open grants makes both GREEN while retained Task reads remain available.

The focused Web gate now passes64 tests across Task client/routes/pages and conversation client/pages. Two additional API integration cases bridge the strict Web clients to actual Fastify/Task/Conversation services with pg-mem: one successful execution and one provider rejection after a completion event. They verify exact replay, persisted actual model and zero-valued usage, archived read-only history, pinned Bot authorship with no human controls, and no final output on failure. Both passed, and API typecheck passed. This is HTTP/domain contract evidence, not native PostgreSQL evidence.

Browser helper source30a48fb and evidence6408158 are included. Eight browser journeys passed, including three new direct/group Task scenarios and all prior conversation/group-Bot scenarios. Detail and list refresh each had an observed stale-navigation RED and pass with explicit reload links. See COL-04-BROWSER-EVIDENCE.md for exact cases and limits.

Web typecheck at the helper pin:0 errors,0 warnings. Changed TypeScript formatting and diff checks passed. The complete combined integration gate and independent two-axis review remain required. No native service or Compose success is claimed.

## Final independent review correction

Both Standards and Specification reviews are CLEAN at source1f68e42933df9b143e0f1e0e3e66a11eea020c49, treebabbd97a8a91e03f6ac64458c5a597ae1fbd64fb. The Spec reviewer found that a bare conversation anchor cannot locate an output after the first30 messages. A real service/worker probe reproduced sequence32 missing from the first page.

The correction adds a conversation-only messageId locator under the existing current authorization transaction. The scoped original sequence and bounded limit guarantee the selected page contains the target; ordinary pagination and the group-Bot context parser remain unchanged. The Web canonicalizes the locator, rejects ambiguous cursors and missing targets, and links the final response using query plus anchor. API/client and SSR/page tests witnessed one API and five Web REDs, then passed after the fix. Cross-conversation, private-reader, missing-target and malformed-query cases are covered; archived history stays read-only. The native successful-worker case now also executes the locator under the restricted role.

Final affected checks:28 API and43 Web tests passed; API/Web type checks passed with0 errors/0 warnings. The8 browser journeys passed again in32.7 seconds on the corrective source; the direct scenario now seeds30 earlier messages and opens/reloads its sequence32 output. Both reviewers independently repeated actual HTTP/domain or worker locator probes successfully. No test retries or timeout increases were introduced.

The complete dedicated merged gate and actual26-case PostgreSQL/separate-worker Compose gates remain required. This author evidence does not close them.
