# Bot tasks and live collaboration

Open a direct Bot conversation and its Tasks page, enter a prompt, and submit. A single submission durably records the human message, Task, and first queued Run. Reloading preserves the Task status, actual provider protocol/model, usage when supplied, and the completed Bot response.

In a group, an explicit Bot mention selects that exact active membership. Otherwise, OpenBot uses an eligible default Bot from **Routing settings**, then a deterministic local match against eligible Bots' names, roles and descriptions. Routing makes no extra model request. **Why this Bot?** opens the saved decision for that Task, including the reason and public candidate scores. Later settings changes do not rewrite that decision or reroute a replayed submission. Group owners and administrators manage the default; each caller's current group and model permissions still apply.

The conversation displays committed draft text and Run updates while the model is working. Reconnecting resumes after the last applied event. If rendering history has expired, the client reloads the authorized current state. Reconnection does not submit another Task. A successful draft converges to one final Bot message; failed draft text is not saved as a completed answer. Current permission changes also apply to open streams.

The original triggering human can manually retry a failed Task while they still have the required conversation, exact group membership grant and model access. A retry creates a new Run on the same Task with the original prompt event, Bot version, model identity and routing decision. It can use a newly admitted credential revision for that same model. Attempt history remains available, including older errors, usage and final-message links. If a retry response is uncertain, confirm it using the unchanged form and command key. A repeated command returns its original Run receipt, even if the Task has advanced since then.

In a group conversation, **Save as group memory** saves a reference to the current visible message version, including a completed Bot message. The memory records its source, creator, creation time and a confidence value supplied by the person saving it. Later same-group Runs can use it only while their current history grant and source permissions allow it. Editing, deleting or purging the source makes that ordinary memory unavailable. Group memory pages support provenance inspection, scoped search and viewing the sources available to a particular Bot membership.

The API writes the queue to PostgreSQL. The separate `worker` Compose service claims queued Runs and calls the configured model. It uses the triggering human's provider permissions; an invited Bot does not lend its creator's personal credentials to group members. Use an authorized workspace model connection for shared group execution.

Set the same `OPENBOT_PROVIDER_ENCRYPTION_KEY` and provider network allowlist for API and worker, then restart both services. The key must be a base64-encoded 32-byte key. An existing installation must retain its original key so stored credentials remain readable. With no key configured, the worker logs `task_worker_unconfigured` and remains idle without claiming or failing queued Runs. Configuring the key and restarting resumes the persisted queue. `task_worker_ready` means the configured worker has verified the database migration state and started polling; individual Task/Run status reports execution outcomes.

For development, after database migrations and environment configuration:

```sh
pnpm --filter @openbot/api worker
```

Production runs `node dist/worker.js`. The worker requires database and provider settings, and has no HTTP listener or object-storage access. `SIGTERM` or `SIGINT` aborts its active model call, waits for the adapter to settle, and records a safe failure when possible. Deadline, text-size and reported cumulative token limits bound an attempt. Provider calls use the pinned Bot version and record the connection revision actually selected.

Authorization and selected memory sources are checked before calling and before later text or final-result publication. Removing a group Bot grant permanently invalidates work tied to that grant; inviting the same Bot again creates a different grant. Bot outputs retain their pinned Bot identity and cannot be edited or deleted through human-message controls.

Restarting the worker processes durable queued Runs. This version leaves an uncertain already-running Run unchanged after an unexpected process exit; automatic retries, fallback, cancellation and crash recovery are still separate implementation tickets. Manual retry applies to failed Tasks and does not reclaim an uncertain running attempt.
