# OpenBot implementation checkpoint

## User constraints

- Implement the approved 67-ticket backlog with TDD; no cloud-computer feature.
- On2026-09-05, after the first publication and green CI, the user instructed “继续实现所有 tickets”. Implementation is active again. Progress continuously through all unblocked tickets; do not treat an automation turn as cancellation.
- On 2026-09-05 the user paused implementation and authorized pushing the verified integration. Publish `feat/openbot-collaboration-system` to the initially empty remote `main`; keep the development branch available. The earlier no-push instruction is superseded for this push.
- Repository tickets remain authoritative. The latest attempt to create GitHub issues was rejected with `403 Resource not accessible by integration`, despite repository read/admin access. No issue was created.

## First push status

The first authorized push on 2026-09-05 was blocked before any ref update: the Git CLI lacked GitHub credentials and the GitHub app returned `403 Resource not accessible by integration`. The user subsequently installed ChatGPT Codex Connector on Blackman99. The installation now appears in the connection and the write API reaches the empty repository without a permission error.

Publication uses the authenticated GitHub API because the shell still lacks GitHub credentials. It publishes the verified file tree after initializing the empty repository. Remote commits will have different IDs from the original local history; the original commits remain available locally. Compare Git tree hashes to verify the published contents. The first published snapshot excluded unfinished PROV-01 work. The user has now resumed implementation.

The first full snapshot was published on 2026-09-05 as remote commit `8759f449b189f6cbafeca1021db1deb45c194f3c` on both `main` and `feat/openbot-collaboration-system`. Its tree `550293dc706ac52e30de4798595d38ba8e32b655` exactly matches local commit `82f933ff71267baaf761577a5f65cb851a8cfc0a`: all 155 tracked files, including the 67 repository tickets. The original `b29e5f5` commit ID is absent from remote history.

Verify run `33937667219` failed in the `code` job before dependency installation: `actions/setup-node` tried to initialize the pnpm cache before pnpm was installed (`Unable to locate executable file: pnpm`). The publication follow-up installs the package-manager version declared in `package.json` using `pnpm/action-setup` before Node's cache initialization in both Node jobs. Actual CI retry is required; PostgreSQL and Compose evidence gates remain open until successful runs are recorded.

Remote follow-up `c177487d7caf5526147b811081cfffc546c29a1e` fixed pnpm initialization. Verify run `33937987129` passed formatting, types, and all 119 unit/integration tests, then exposed a workspace browser-test navigation race. Locally the existing test failed in 4 of 5 repetitions; a temporary request probe confirmed the submitted name was still `Research`, because filling the shared form raced the switch back to that workspace. The test now waits for the target URL and heading before editing, and additionally verifies rename persistence after refresh. All 5 focused repetitions passed without changing application behavior or increasing retries/timeouts. The probe was removed; the complete CI retry is pending.

Verify run `33938219583` on remote `42bc88caa7b319636d3cc603f7cbfa40e0c24d74` passed the full `code` and real `postgres-auth` jobs. Compose passed fresh startup, upgrade startup, and failure-log redaction, then failed its password-rotation assertion because the test used trusted loopback connections inside the database container. The next retry connects the password checks through the `postgres` service address, and requires the old password to fail specifically with an authentication error. Remaining Compose evidence is still pending; no further feature tickets have resumed.

Verify run `33938409265` on remote `27aff5f278430744a9c18740e9bada62cf2e08c8` passed code, PostgreSQL, and all Compose startup, password-rotation, privilege, authentication, and workspace checks. The final outage check reached HTTP 503 but its JSON assertion failed because the `jq` invocation omitted the `.` filter and parsed the file path as an expression. The corrected invocation is locally verified against the expected outage payload; a full CI retry is pending.

## Completed implementation

- FND-01, AUTH-01, WS-01 are complete with all original external evidence closed.
- PROV-01 implementation integrated as `af206cf`; local145 unit/integration +6 browser tests pass. Provider PostgreSQL/Compose gate `PROV-01-E1` is closed by Verify33941168646.
- WS-02 integrated as `62b0ab6`; combined 186 unit/integration tests and 7 browser scenarios pass, with formatting, types and builds. Both independent review axes passed. Invitation-specific real PostgreSQL/Compose gate `WS-02-E1` is closed by Verify33941168646.
- Provider CI run `33940612309` passed code, authentication PostgreSQL and Compose. The provider PostgreSQL job exposed a missing root `pg` dependency in the infrastructure command. Commit `ff6ec6a` fixes the dependency after a witnessed failing regression, and the three targeted command tests pass; actual CI retry passed on the integrated invitation revision.
- Latest published baseline: `ecc586a8d3b528728af2308e247c4c3c4fb75ffa`; equivalent local commit `2ebd76fbdf7df14e09f94168432f7e7dc1a327b4`, tree `376fc917ab281c6e38fe928603a146a32d87027b`.
- [Verify33938570768](https://github.com/Blackman99/openbot/actions/runs/33938570768) completed successfully on2026-09-05 at02:17 UTC:119 unit/integration tests,5 browser scenarios,2 real PostgreSQL tests, formatting/types/builds, and all fresh/upgrade/runtime-role/auth/workspace/outage Compose checks.
- First-publication CI fixes install pnpm before cache initialization, wait for workspace navigation in browser tests, use authenticated TCP for password-rotation checks, and supply the jq identity filter for outage assertions.

Latest feature CI: [Verify33941168646](https://github.com/Blackman99/openbot/actions/runs/33941168646) passed all four jobs on remote `98f15fc88cdc44bc6cd14ac5542a9aad3fb58166` (tree matches local `014320d`), completed on 2026-09-05 at 03:13:55 UTC. Five real PostgreSQL tests passed across the isolated authentication/invitation and provider jobs, alongside the restricted-role Compose smoke. PROV-01 and WS-02 are now fully complete.

PROV-03 integrated as `b689e0e`: 213 unit/integration tests and 7 browser scenarios, formatting, types and production builds pass. Both independent review axes are clean at code revision `271aa4a`; Responses protocol, general live generation, bounded diagnostic capture and SSE framing are covered. Actual PostgreSQL/Compose gate `PROV-03-E1` is closed by [Verify33941574408](https://github.com/Blackman99/openbot/actions/runs/33941574408), all four jobs successful on remote `8f7e47f50a935cffc849e29c73b48a89d75ee449`, completed on 2026-09-05 at 03:22:16 UTC.

## Active frontier

- WS-03: workspace member roles, invitation provenance and session identity independent of membership; worktree `.worktrees/ws-03`, migration0006 reserved if required.
- AUTH-02: optional OIDC sign-in, explicit linking and invitation-only registration; prep complete, integrated WS-02 baseline available; migration0007 reserved if required.
- PROV-04 integrated as `87632a1`: 249 unit/integration tests and 8 browser scenarios, formatting, types and builds pass. Both independent reviews completed; the standards P3 protocol-switch issue was fixed and rechecked at `b58ec82`. Actual PostgreSQL/Compose gate `PROV-04-E1` awaits CI.
- WS-03 reviewed candidate `4ac4fbc` passed 221 tests and 8 browser scenarios; both review axes are clear, including real HTTP regressions for member/invitation DELETE headers and response-body deadlines. Integrate next, then unlock PROV-02, COL-01 and API-01.
- PROV-02 is being prepared read-only until the WS-03 integration baseline is available.
- PROV-01 is integrated; migration0004 is `personal_model_connections`.
- WS-02 is integrated; migration0005 is `workspace_invitations`. AUTH-02 research and transaction handoff are in `OIDC-NOTES.md` and the WS-02 ticket.
- Use a separate worktree and ticket branch for each implementation. Merge and verify one completed ticket at a time. Keep API/Web build commands serial within each worktree.
- E2E ports4399/4173 are serialized by root; AUTH-02 owns the current browser lease. Each real PostgreSQL suite must use its own disposable database or schema. Local PG provisioning was blocked by unavailable build tools/download403; real PG gates run in GitHub CI.
- GitHub main remains the verified published baseline while the complete backlog is developed on the feature branch; unified draft PR: https://github.com/Blackman99/openbot/pull/1.

## Integration handoffs

- WS-03 must separate authenticated identity from workspace membership. The current authentication query joins a membership, so removing a user's final membership would turn a valid session into HTTP 401. WS-03 explicitly requires HTTP 403 on that workspace while the session remains valid.
- Browser suites use a shared fixture server on ports 4399 and 4173. Give one worktree exclusive E2E ownership at a time; tests that reset shared fixture state also need one worker.
- PROV-01 review found that a late probe could overwrite a newer disable or credential update. Its implementation now includes a revision check and concurrent-write regressions; verify this behavior survives merging.
- Preparatory primary-source notes for the Responses and Anthropic adapters are in `PROVIDER-PROTOCOL-NOTES.md`.

## Continuity

The CI monitoring request is separate from implementation. An empty remote repository or unchanged CI state does not complete or cancel the local backlog. The explicit user resume is active; continue using this checkpoint and the issue index.

## External release evidence

FND-01-E1, AUTH-01-E1, and WS-01-E1 are closed by the successful baseline CI above. Record any new unexecuted evidence in REL-01. Fixture-based browser tests and pg-mem do not substitute for real PostgreSQL or Compose execution on later changes.

## BFF HTTP handoff

Send JSON Content-Type only with an actual JSON body; Fastify rejects empty JSON DELETE requests. Keep AbortController deadlines active through response-body parsing. WS-03 adds real client-to-Fastify and stalled-HTTP regressions for both member and invitation clients; browser fixtures alone had masked these defects. Preserve these contracts in subsequent API clients.
