# Single-Bot tasks

Open a direct Bot conversation and its Tasks page, enter a prompt, and submit. In a group conversation, select an active Bot grant before submitting. A single submission durably records the human message, Task, and first queued Run. Reloading the page preserves the status, actual provider protocol/model, usage when supplied, and the completed Bot response.

The API writes the queue to PostgreSQL. The separate `worker` Compose service claims queued Runs and calls the configured model. It uses the triggering human's provider permissions; an invited Bot does not lend its creator's personal credentials to group members. Use an authorized workspace model connection for shared group execution.

Set the same `OPENBOT_PROVIDER_ENCRYPTION_KEY` and provider network allowlist for API and worker, then restart both services. The key must be a base64-encoded 32-byte key. An existing installation must retain its original key so stored credentials remain readable. With no key configured, the worker logs `task_worker_unconfigured` and remains idle without claiming or failing queued Runs. Configuring the key and restarting resumes the persisted queue. `task_worker_ready` means the configured worker has verified the database migration state and started polling; individual Task/Run status reports execution outcomes.

For development, after database migrations and environment configuration:

```sh
pnpm --filter @openbot/api worker
```

Production runs `node dist/worker.js`. The worker requires database and provider settings, and has no HTTP listener or object-storage access. `SIGTERM` or `SIGINT` aborts its active model call, waits for the adapter to settle, and records a safe failure when possible. A failed model call never publishes its partial text as a completed Bot response. Deadline, text-size and reported cumulative token limits bound an attempt. Provider calls use the pinned Bot version and record the connection revision actually selected.

Authorization is checked before calling and again before publishing. Removing a group Bot grant permanently invalidates queued work tied to that grant; inviting the same Bot again creates a different grant. Bot outputs retain their pinned Bot identity and cannot be edited or deleted through human-message controls.

This slice creates one attempt and does not automatically reclaim running work after a process crash. Cancellation, retries, fallback and crash recovery are separate tickets. Restarting the worker processes queued Runs; it does not claim exactly-once external model execution or silently retry an uncertain running attempt.
