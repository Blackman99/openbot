# ATT-01 accepted integration

Reviewed source15df0ace6616eb483e2a6e069e59a9d40694dd25/tree501056c459549d9565b800f982ccf66aaea18f1a; author finalb4cd67498b21269f702ec73803acb1c14f1e2ac9 adds verification documentation. Both independent Standards and Specification axes are CLEAN.

Dedicated merge0bbaf8562fc2727cc5c563f1f3a1555cdd910779/tree4ec3bdd61b175c32ef53f773673623ba535a8629 has parentscb997737 andb4cd6749. Independent shared integration review covered10 paths and preserved34 incoming and62 root changed blobs exactly. One additional root test changed only a comment and its case-level15-second budget: the initial full run timed out at5,193ms in a30-message/worker/real-HTTP setup; unchanged focused cases then passed. All locator, single-output, authority, privacy and production deadline assertions remain intact. That exact two-line budget delta was separately reviewed CLEAN.

The final complete pnpm verify ran2026-09-05 from09:41:49.612 through09:45:35.585 UTC and exited0. API99 unit+359 integration and Web65 unit+539 integration yield1,062 passing nonbrowser tests;36 ordinary browser scenarios and one signed OIDC journey passed. Formatting, API/Web typechecks with zero errors/warnings and both final builds passed. The attachment browser covers3MiB upload, replay, download and purge; current conversation/Task locator journeys remain included.

Actual migration order is0016→0017→0018. Private attachment metadata/content, source-bounded group access, attachment-only purge, active staged-write cleanup fencing, OOXML structural validation and bounded namespace work remain preserved. Task author/locator/native26/separate-worker Compose and Bot Copy/lifecycle remain intact. No registry placeholder or prior migration rewrite was introduced.

Actual PostgreSQL5, private S3 and deployed attachment Compose are still ATT-01-E1. Native skips are not service passes. Separately reviewed native Task audit correction483ba992 is a later test-only commit, not a claim that the failed actual CI retry already passed.
