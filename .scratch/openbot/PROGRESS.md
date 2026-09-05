# OpenBot local implementation checkpoint

## User constraints

- Implement the approved 67-ticket backlog with TDD; no cloud-computer feature.
- On 2026-09-05 the user paused implementation and authorized pushing the verified integration. Publish `feat/openbot-collaboration-system` to the initially empty remote `main`; keep the development branch available. The earlier no-push instruction is superseded for this push.
- Repository tickets remain authoritative. The latest attempt to create GitHub issues was rejected with `403 Resource not accessible by integration`, despite repository read/admin access. No issue was created.

## First push status

The first authorized push on 2026-09-05 was blocked before any ref update: the Git CLI lacked GitHub credentials and the GitHub app returned `403 Resource not accessible by integration`. The user subsequently installed ChatGPT Codex Connector on Blackman99. The installation now appears in the connection and the write API reaches the empty repository without a permission error.

Publication uses the authenticated GitHub API because the shell still lacks GitHub credentials. It publishes the verified file tree after initializing the empty repository. Remote commits will have different IDs from the original local history; the original commits remain available locally. Compare Git tree hashes to verify the published contents. Implementation remains paused and unfinished PROV-01 work is excluded.

## Completed implementation

- FND-01: deployable application foundation. Docker execution remains external gate `FND-01-E1`.
- AUTH-01: local-owner setup, persistent sessions, password protection, Origin checks, append-only audit schema, migration ledger, and runtime-role separation. Real PostgreSQL/Compose evidence remains external gate `AUTH-01-E1`.
- AUTH-01 final `pnpm verify` passed on 2026-09-05 with 112 unit/integration tests, 4 browser tests, strict types, formatting, and production builds. Independent final review found no deterministic blockers.
- WS-01: membership-scoped workspace creation, navigation, settings, and safe audits. Feature commit `4a7b47a` merged locally as `982fe52`; root review found no deterministic blocker.
- WS-01 integration `pnpm verify` passed on 2026-09-05: API unit 46/46, Web unit 7/7, API integration 41/41, Web integration 25/25, browser 5/5, formatting, strict types, and both production builds. Real PostgreSQL/Compose evidence remains external gate `WS-01-E1`.

## Next frontier

- Implementation is paused at the user's request. PROV-01's unfinished code and reviews are retained in its isolated local worktree; they are not included in the verified integration being pushed.
- WS-02: one-time invitations for new and existing users; unlocked by WS-01 with `WS-01-E1` retained in REL-01.
- PROV-01: personal OpenAI Chat-compatible connections.
- Use a separate worktree and ticket branch for each implementation. Merge and verify one completed ticket at a time. Keep API/Web build commands serial within each worktree.

## Integration handoffs

- WS-03 must separate authenticated identity from workspace membership. The current authentication query joins a membership, so removing a user's final membership would turn a valid session into HTTP 401. WS-03 explicitly requires HTTP 403 on that workspace while the session remains valid.
- Browser suites use a shared fixture server on ports 4399 and 4173. Give one worktree exclusive E2E ownership at a time; tests that reset shared fixture state also need one worker.
- PROV-01 review found that a late probe could overwrite a newer disable or credential update. Its implementation now includes a revision check and concurrent-write regressions; verify this behavior survives merging.
- Preparatory primary-source notes for the Responses and Anthropic adapters are in `PROVIDER-PROTOCOL-NOTES.md`.

## Continuity

The CI monitoring request is separate from implementation. An empty remote repository or unchanged CI state does not complete or cancel the local backlog. Respect the explicit implementation pause above; use this checkpoint and the issue index when the user resumes work.

## External release evidence

`REL-01` must not complete until actual Docker Compose and PostgreSQL runs close the explicitly unchecked evidence on FND-01, AUTH-01, and WS-01. Fixture-based browser tests and pg-mem do not prove PostgreSQL transaction/concurrency or trigger behavior.
