# COL-06 first implementation slices

This checkpoint is incomplete and is not an acceptance or publication claim.

Witnessed RED→GREEN through the real unit/integration commands:

- Missing matcher module→explicit mention precedence; eligible default initially
  threw mentioned_bot_unavailable, then passed; absent default/local selection
  initially threw no_eligible_bot, then stable local match and tie tests passed.
- Chinese prompt initially selected the zero-score wrong Bot; local Han bigrams
  now select the matching role. A caller's extra private configuration initially
  leaked into evidence; explicit persona projection now excludes it.
- Missing routing service→current group-only default inspection. The missing
  update operation then failed, followed by successful exact-grant default CAS,
  mandatory safe audit, member denial and reconstructed readback.
- Actual Fastify routing GET initially returned404; GET/PATCH now pass session,
  private-cache, exact-Origin, strict-input and fixed409 conflict checks.

The focused gate passed8 unit plus5 integration tests (13 total). Added regressions
preserve clearing an unavailable default and retained closed-grant identity after a
replacement invitation. API typecheck and formatting passed. No provider call is
part of matcher/default admission; fixtures' existing model creation probes are
separate setup operations.

## Transaction and Task slices

The missing group admission helper was witnessed RED, then the real group/model
admission and mention/default/local order passed. The next automatic Task test
failed with TaskAccessError before implementation. It now atomically retains one
human trigger, Task, first Run, decision and both Task/routing audits. Its separate
request hash distinguishes automatic routing from an explicit mention, while the
existing trigger/Task hash still uses the resolved grant. Reconstructed replay keeps
the original decision after default changes and checks the pinned grant/version and
the actual human's current model rights without rerouting.

The receipt HTTP test initially returned404. The private Task receipt endpoint now
passes authenticated/scope-only inspection, private cache, strict query and safe
unavailable-model errors. Full evidence is read for one Task; list/get DTOs contain
only the optional algorithm/reason summary. Current group members can still read
historic evidence after the selected grant, Bot or provider becomes unavailable.

On2026-09-05, the focused gate passed **8 unit +13 integration =21 tests**, with API
typecheck passing. These include actual member vs grantor personal-model rights,
no implicit direct Bot ACL, unavailable explicit mention never falling back, and
removed/disabled/archived/incompatible candidate exclusion. Setup-only pg-mem lacks
native regex/length operators; the standalone schema uses the existing CHAR(64)
hash representation. Its final PostgreSQL guard must validate immutable/same-scope
decision identity and the hash format independently.

Migration0021 remains unregistered pending actual0019/0020. These focused fixtures
install the standalone routing tables; other Task fixtures do not yet have them,
so no whole-suite or migrated-service pass is claimed. Web controls, native guards/
locking, COL05 integration and full browser evidence remain. No local PostgreSQL,
Docker, S3, browser services or global ports were started for these slices.
