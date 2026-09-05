# OpenBot

OpenBot is an AGPL-licensed, self-hosted multi-bot collaboration system. The current
implementation includes local and optional OIDC authentication, workspace membership, groups,
scoped API tokens, and persistent Bot identities: a SvelteKit web app, a Fastify
API, PostgreSQL migrations, and a Docker Compose development stack. Personal OpenAI Chat Completions, Responses, and Anthropic Messages-compatible
model connections support credential-safe settings and live text/action compatibility probes.

Workspace model connections support shared use without sharing credentials. Capability settings
record verified evidence, explicit overrides, and compatible fallback chains.

The approved implementation backlog lives in
[`.scratch/openbot/issues/`](.scratch/openbot/issues/README.md).

## Quick start

Requirements: Docker with the Compose plugin.

```bash
cp .env.example .env
docker compose up --build
```

The example explicitly enables placeholder passwords for an isolated local stack. Before any
non-local deployment, set unique `POSTGRES_PASSWORD` and `OPENBOT_DATABASE_PASSWORD` values,
replace `OPENBOT_SETUP_TOKEN` with a high-entropy secret of at least 32 bytes, update
`DATABASE_URL`, and set `OPENBOT_ALLOW_INSECURE_LOCAL_PASSWORD=false`; PostgreSQL otherwise
refuses the example passwords.

Published ports bind to loopback by default. If the service must accept remote connections, set
`OPENBOT_BIND_ADDRESS` deliberately, use a high-entropy `OPENBOT_SETUP_TOKEN`, terminate TLS, and
set `WEB_ORIGIN` to the exact external HTTPS origin before exposing either port.

When every service is healthy:

- Web status: <http://localhost:3000>
- First-owner setup: <http://localhost:3000/setup>
- Protected workspace: <http://localhost:3000/app>
- Versioned API status: <http://localhost:3001/api/v1/status>

The first setup asks for the `OPENBOT_SETUP_TOKEN` from `.env`, then atomically creates the
instance administrator, default workspace, owner membership, and a persistent session. Later
setup attempts are rejected. The setup secret is sent only for that claim request and is never
written to the application database or audit history. For any non-loopback deployment, set
`WEB_ORIGIN` to the exact external HTTPS origin; the API and SvelteKit server use that same value
for Origin checks and Secure cookies.

The Compose migration service alone receives the PostgreSQL owner credentials. The API connects
as the fixed, non-superuser `openbot_runtime` role using `OPENBOT_DATABASE_PASSWORD`. That role
can perform the application queries required by authentication, but cannot change database
schema, remove the audit trigger, or update, delete, or truncate `audit_events`.

Stop the stack with `docker compose down`. Add `--volumes` only when you intentionally want to
remove local PostgreSQL data.

## Optional OIDC

OIDC stays disabled when its environment values are empty. To enable a provider, register a
confidential Authorization Code client using `client_secret_post` with the exact redirect URI
`WEB_ORIGIN/auth/oidc/callback`, then set `OIDC_ISSUER_URL`, `OIDC_CLIENT_ID`, and
`OIDC_CLIENT_SECRET` and restart the API. The provider must support S256 PKCE, OIDC discovery,
and signed ID tokens with a JWKS endpoint. Issuer and backend provider endpoints must use HTTPS.
The loopback HTTP exception is limited to the automated test environment.

Existing users sign in locally and open **Security settings** to explicitly link their provider
identity. Later OIDC sign-in matches the exact issuer and subject; an email match never merges
accounts. New users can join only through a valid workspace invitation, with a verified provider
email matching the invitation. OIDC-only accounts cannot unlink their final credential.
Security settings remain available if a user has no workspace memberships.

The client uses Authorization Code, PKCE, state, nonce, signature verification, and a ten-minute
single-use transaction tied to an HttpOnly browser cookie. Invitation acceptance commits the
account, external identity, membership, session, and audits together. Callback errors return to
clean application URLs without authorization codes or state in error messages.

## Workspace API tokens

Select **API tokens** in a workspace to create a named token with fixed scopes and an expiration
(default 30 days, maximum 365 days). Copy the secret from the creation result; subsequent loads
show only metadata. Revoke a token from the same page. You can manage only your own tokens.

The public identity endpoint is `GET /v1/me`, authenticated with
`Authorization: Bearer <your-token>` and the `me:read` scope. It returns the creator, the bound
workspace and current role, and token ID/scopes. Browser session identity remains `/api/v1/me`.
Tokens in URL query parameters are rejected. Invalid, expired, revoked, or orphaned tokens return
401; a valid token without the required scope returns 403.

The fixed scope catalogue is `me:read`, `bots:read`, `bots:write`, `groups:read`, `groups:write`,
`tasks:read`, `tasks:write`, `tasks:approve`, and `events:read`. The resource scopes are reserved for
the corresponding public resource endpoints. Scopes never add permissions to their creator:
each operation must also enforce current workspace and resource access. Removing a workspace
member permanently revokes their tokens, including if they later rejoin. Only SHA-256 digests
are persisted, and creation, permitted or insufficient-scope use, and revocation produce audits
without credential material.

## Personal model connections

After signing in, select **Personal models** in the workspace, or open
<http://localhost:3000/app/settings/models>. Before enabling connections, generate a key with
`openssl rand -base64 32`, set `OPENBOT_PROVIDER_ENCRYPTION_KEY` in `.env`, and restart the API.
Preserve that key across restarts and backups; changing it makes existing credentials unreadable.
An empty key disables connections while the rest of the instance remains available.

`OPENBOT_PROVIDER_ALLOWED_HOSTS` is a comma-separated list of exact endpoint hostnames and defaults
to `api.openai.com`. Schemes default to HTTPS; opt into HTTP through
`OPENBOT_PROVIDER_ALLOWED_SCHEMES` only for explicitly trusted local providers. A private address
also requires its CIDR in `OPENBOT_PROVIDER_PRIVATE_CIDRS`. Every resolved address is checked
before connecting, DNS answers are pinned for the request, and redirects are rejected. For a
local provider, allow its hostname, scheme, and private CIDR explicitly.

Create a connection with an explicit protocol (**OpenAI Chat Completions**, **OpenAI Responses**, or **Anthropic Messages**),
a name, base URL (for example `https://api.openai.com/v1`), model ID,
optional API key, and optional custom headers as a JSON object. **Test and save** first probes a
live text stream and a structured action, then stores timestamped, sanitized evidence. Failed
text probes save a disabled connection; working text remains usable when structured actions are
unsupported. Existing connections default to Chat Completions; protocols are never guessed from the
endpoint. All adapters normalize text, live deltas, function actions, usage, and completion through a
shared model-event contract with cancellation and rate-limit classification. Settings allow inspection, editing, retesting, disabling, and deletion. Blank secret
fields on edit retain existing values; use **Clear saved API key** or `{}` headers to remove them.

Anthropic connections use the `anthropic-messages` protocol, send the API key as `x-api-key`, and
append `/messages` to the configured base URL. Set **Anthropic version** (`anthropicVersion` in
the API) to the compatibility endpoint's supported version; the default is `2023-06-01`.
Custom headers cannot override that version or duplicate a supplied API key. Streamed local
`tool_use` blocks become structured actions; hosted tools and Computer Use are not executed.

API keys and all custom header values use AES-256-GCM encryption with per-save random nonces and
owner/connection binding. Reads expose only configured markers and header names. Personal
connections are available exclusively to their owner. The authenticated API is rooted at
`/api/v1/model-connections`; mutations require the configured web Origin and a session cookie.

## Bot identities

Select **Bots** in a workspace to create a private Bot with a name, role, description,
instructions, an available model, and default execution limits. Creation records immutable
version 1 and makes the creator its owner. The detail page shows the saved configuration and
the model's current availability. Basic-only models are labeled chat-only. Workspace
administration does not grant access to another user's private Bot.

Bot owners can open **Manage permissions** from the detail page to grant owner, editor or user
access and choose private or workspace discovery. Discovery exposes summary information only;
configuration and use require an explicit Bot grant. The last owner with current workspace access
cannot be removed through Bot permissions. Workspace removal immediately disables access while
retaining the grant; explicit Bot revocation removes it. Neither setting changes version history.

## Local development

Node.js 24 and pnpm 11 are required.

```bash
corepack enable
pnpm install --frozen-lockfile
cp .env.example .env
pnpm db:migrate
pnpm --filter @openbot/api dev
pnpm --filter @openbot/web dev
```

For local processes, provide PostgreSQL at the `DATABASE_URL` in `.env`. The web server reads
`API_BASE_URL` and never exposes database connection details to the browser.

## Verification

```bash
pnpm verify
```

This runs formatting checks, strict TypeScript and Svelte checks, unit tests, HTTP integration
tests, Playwright coverage for readiness, local authentication, and a signed mock OIDC provider, and production
builds.

CI additionally runs the real PostgreSQL authentication and personal-provider invariants. With a disposable PostgreSQL
database, the same test can be run manually:

```bash
TEST_DATABASE_URL=postgresql://openbot:password@localhost:5432/openbot_test \
  pnpm --filter @openbot/api run test:postgres
```

Provider persistence and runtime privilege checks use a separate disposable database:

```bash
TEST_PROVIDER_DATABASE_URL=postgresql://openbot:password@localhost:5432/openbot_providers_test \
  pnpm --filter @openbot/api run test:postgres
```

Docker is also required to validate `docker compose up --build` itself. The Compose stack runs a
one-shot, idempotent migration and privilege service as soon as PostgreSQL is healthy. The API
does not start during initial stack startup until the migration and privilege gate succeeds, so
the first API process receives only the restricted runtime role. Run later schema changes during
a maintenance window that restarts the API after the migration service finishes. Once started,
the API remains running and its readiness endpoint reports `Unavailable` during a later database
outage. The web service starts after the API container.
PostgreSQL and migrations live on an internal data network; the web container can reach only the
API over a separate frontend network.

## License

OpenBot is licensed under the [GNU Affero General Public License v3.0 only](LICENSE).

OIDC runtime privilege checks use their own disposable database and the deployed grant script:

```bash
TEST_OIDC_DATABASE_URL=postgresql://openbot:password@localhost:5432/openbot_oidc_test \
  pnpm --filter @openbot/api run test:postgres
```

The `postgres-auth` CI job runs OIDC callback/invitation concurrency, transaction rollback, and
session-revocation checks. The `postgres-oidc` job verifies link, sign-in, invited registration,
last-credential protection, and rollback using the restricted runtime role. These real PostgreSQL
checks supplement the in-memory SQL browser fixture and must pass before release.
