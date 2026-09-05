# PROV-05 verification

Base: `1e1f6643d4a410667fc460c658bf1fc004143b91`.
Implementation is isolated on `ticket/prov-05`. Root owns integration and external gate closure.

## Contract and scope

See [API contract](PROV-05-API-CONTRACT.md). Five explicit flags: text, streaming, toolCalling,
structuredOutput and visionInput. Basic requires text plus streaming; Collaboration additionally
requires verified or justified manual toolCalling/structuredOutput. Enhanced vision remains unknown
until explicitly justified; no protocol/model naming inference. Existing actual Chat, Responses and
Anthropic probes remain shared. Member saved-credential tests remain permitted and attributable.

Policies carry independent target generations, immutable before/after audit snapshots, required
manual rationale and persistent active/stale manual badges. Same-scope fallback graphs are updated
under a shared scope lock with optimistic revisions and deterministic current-state preview.
Internal durable binding admission reuses the scope lock without exposing credentials.

## Red to green evidence

- Persisted catalog: missing capability service/route -> attributable Basic catalog and HTTP200;
  unsupported action does not grant Collaboration and optional capabilities remain unknown.
- Target edit: stale generation1 and false Collaboration -> generation2 with fresh successful action
  proof; name edits and subsequent probes retain that target generation.
- Manual override: missing mutation -> required rationale, sanitized output, audited actor/time,
  persistent badge through probes, stale revision conflict and inactive old-target override.
- Workspace policy routes:404 -> administrative override/reprobe with member403; existing member
  `/test` refreshes proof using the actual member actor while retaining manual provenance.
- Graph: missing mutation -> same-scope ordered DFS, shared descendants once, duplicate/cycle/
  capability rejection and fresh disabled/deleted exclusion reasons.
- Real HTTP BFF: missing fallback route returned unsuccessful decoded result -> personal and shared
  client catalog/override/reprobe/fallback/preview contracts pass, including stale errors and revocation.
- Durable binding: missing module -> transaction-scoped safe Basic binding; credential rotation keeps
  model identity while model drift, disabled state and missing Basic proof reject.
- Personal probe admission: concurrent disable allowed the next dispatch and only failed final CAS
  -> disabled state rejects before the next dispatch, preserving current revision and disabled state.

## API checkpoint gates at `92657f14e3131778380d977a53dc3ffe0d5a1ad4`

- `pnpm --filter @openbot/api typecheck`: passed.
- `pnpm --filter @openbot/api test:unit`:77 passed.
- `pnpm --filter @openbot/api test:integration`:171 passed, maxWorkers4.
- `pnpm lint`: passed.
- `pnpm --filter @openbot/api test:postgres`:17 skipped because no test database URLs are available.
  This is discovery/type coverage, not PostgreSQL evidence.

The focused HTTP tests use real Fastify listeners on ephemeral ports and the production strict Web
clients. The unit/integration storage fixture uses pg-mem and a no-op advisory function; it cannot
prove PostgreSQL lock scheduling, runtime privileges or rollback.

## Final code and local gates

Final code candidate: `3468fa8649b74927354b94dd91ccad18652cfd52`.

- API review fix `69a2fd18e47d4ebc04f85fb5b34bc691401d4c08`: the new personal override used
  the caller's UUID spelling for credential AAD. Real Fastify uppercase-UUID regression failed503
  then passed200 after using the stored metadata ID. Historical personal ciphertext context remains
  unchanged. Nine affected API tests and API typecheck passed.
- UI child final `293089ce50ea62640fa76b2f4153301eb7cf6007`, transferred unchanged as `3468fa8`:
  Web22 unit and186 integration tests passed; Svelte reported zero errors/warnings; lint passed.
  Canonical-ID client regressions failed before all five methods matched the canonical returned ID.
- UI browser coverage: the ordinary Playwright gate passed all12 scenarios,
  including both new capability journeys. The Web build passed inside this browser gate. The child
  also ran the targeted pair successfully. The fixture exercises real browser/BFF interactions,
  not production provider transport or PostgreSQL. OIDC's separate signed-IdP journey was not rerun.
- Browser regression: native HTML omitted a selected disabled fallback option on save. The form now
  retains the saved disabled/missing option in submission so API validation reports unavailable and
  preserves the saved chain. The scenario verifies that rejection and explicit stale-revision reload.
  An earlier browser assertion also needed narrowing to current capability content because prior
  authorized settings hydration can remain in the document; whole-document credential checks remain.
- Final parent gate on `3468fa8`: both actual HTTP API/strict BFF client test files passed8 tests;
  `pnpm lint`, `pnpm typecheck`, `pnpm build`, and `git diff --check` passed. This covers both scopes
  after the final client decoder hardening, with zero Svelte errors/warnings and both production builds.

The verified component totals are456 unit/integration tests (API77+171, Web22+186) plus12 ordinary
browser scenarios. Full component suites were not redundantly rerun after unchanged transfers;
version-specific affected checks are recorded above. Browser ports4399/4173 were released and
confirmed non-listening/bindable by the child.

## Independent reviews

- Standards: clean at `3468fa8649b74927354b94dd91ccad18652cfd52`. The original reviewer rechecked
  the stored-ID AAD fix and final UI/client delta and independently passed9 API+46 Web targeted tests.
  No unresolved finding. Browser and real PostgreSQL/Compose were not independently rerun.
- Spec: clean at `3468fa8649b74927354b94dd91ccad18652cfd52`, including all seven ACs and the
  exact final Web/client delta. The original reviewer independently passed46 Web render/action/client
  tests across three files. No unresolved finding; real PostgreSQL/Compose remain gated.

## External gate: PROV-05-E1

Actual PostgreSQL runtime/Compose execution on the final integrated revision remains required.
No PostgreSQL test database URLs were supplied and Compose was not run locally; pg-mem is not substituted for this proof.

E1 definitions include migration0011 and narrow workspace policy UPDATE grants, opposing concurrent
A-to-B/B-to-A graph edits in both personal and workspace scopes, policy/audit rollback, personal
users UPDATE denial, and binding locks held until the caller transaction commits. Actual execution
belongs to CI after root integration; no external success is claimed here.


## Integration seams

Migration0011 adds non-null legacy-safe policy columns to personal and workspace connection tables.
Root's final unpublished sequence is0009 groups,0010 tokens, then0011 capability policies. Preserve
root migrations0007/0008 and narrow runtime grants; workspace policy UPDATE is explicitly added and
Compose column privileges assert it. Root's newer historical `throughVersion` migration fixture
should replace this branch's older fixture teardown during integration, retaining all ledger/grants
checks. Preserve root maxWorkers4 and lazy OIDC import fixes plus the separately reviewed PostgreSQL
Compose readiness repair. No new package dependency is required.

The future Bot binding seam is documented in the API contract and implemented only as provider
admission: callers hold their workspace lock first and keep the same SqlConnection transaction open
through their dependent durable write. No Bot tables, ownership logic, task retries or model switching
are implemented by this ticket. Root owns index/PROGRESS/REL closure and publishing.
