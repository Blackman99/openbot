import { spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, expect, it } from 'vitest';
import { parse } from 'yaml';

const repositoryRoot = fileURLToPath(new URL('../../../..', import.meta.url));
const directories: string[] = [];
afterEach(() => {
  for (const directory of directories.splice(0)) rmSync(directory, { recursive: true });
});

function fixture(phase?: string, environment: Record<string, string> = {}) {
  const directory = mkdtempSync(join(tmpdir(), 'openbot-pg-readiness-'));
  directories.push(directory);
  const events = join(directory, 'events.jsonl');
  const waits = join(directory, 'waits');
  writeFileSync(events, '');
  writeFileSync(waits, '0');
  const executable = (name: string, source: string) =>
    writeFileSync(join(directory, name), `#!/bin/sh\n${source}`, { mode: 0o700 });
  executable('pg_isready', 'exit 0');
  executable(
    'psql',
    `host='' database='' user='' query=''
while [ "$#" -gt 0 ]; do
  case "$1" in
    --host) host="$2"; shift ;;
    --dbname) database="$2"; shift ;;
    --username) user="$2"; shift ;;
    --command) query="$2"; shift ;;
  esac
  shift
done
read -r waits < "$OPENBOT_TEST_WAITS" || true
phase="$OPENBOT_TEST_PHASE"
if [ -z "$phase" ]; then
  if [ "$waits" -ge 2 ]; then phase=ready; else phase=temporary; fi
fi
kind=seed
if [ "$query" = 'SELECT 1' ]; then kind=probe; fi
authenticated=false
if [ "$PGPASSWORD" = "$POSTGRES_PASSWORD" ]; then authenticated=true; fi
host_json=null
if [ -n "$host" ]; then host_json="\\\"$host\\\""; fi
printf '{"kind":"%s","host":%s,"database":"%s","user":"%s","authenticated":%s,"connectTimeout":"%s","options":"%s"}\\n' \\
  "$kind" "$host_json" "$database" "$user" "$authenticated" "$PGCONNECT_TIMEOUT" "$PGOPTIONS" >> "$OPENBOT_TEST_EVENTS"
if [ "$kind" = seed ]; then test "$phase" = ready; exit $?; fi
if [ "$phase" = temporary ] && [ -z "$host" ]; then exit 0; fi
test "$phase" = ready && test "$host" = postgres && test "$database" = "$POSTGRES_DB" && \\
  test "$user" = "$POSTGRES_USER" && test "$authenticated" = true || exit 2
printf '1\\n'`,
  );
  executable(
    'sleep',
    `read -r waits < "$OPENBOT_TEST_WAITS" || true
printf '%s' "$((waits + 1))" > "$OPENBOT_TEST_WAITS"`,
  );
  executable(
    'docker',
    `if [ "$1 $2" = 'compose up' ]; then exit 0; fi
if [ "$1 $2 $3 $4" != 'compose exec -T postgres' ]; then exit 99; fi
shift 4
exec "$@"`,
  );
  return {
    run(command: string) {
      return spawnSync('bash', ['-eu', '-o', 'pipefail', '-c', command], {
        encoding: 'utf8',
        timeout: 5_000,
        env: {
          ...process.env,
          PATH: `${directory}:${process.env.PATH}`,
          POSTGRES_USER: 'openbot',
          POSTGRES_DB: 'openbot',
          POSTGRES_PASSWORD: 'fixture-password',
          ...environment,
          OPENBOT_TEST_EVENTS: events,
          OPENBOT_TEST_WAITS: waits,
          OPENBOT_TEST_PHASE: phase ?? '',
        },
      });
    },
    events: () =>
      readFileSync(events, 'utf8')
        .trim()
        .split('\n')
        .filter(Boolean)
        .map((line) => JSON.parse(line) as Record<string, unknown>),
    waits: () => Number(readFileSync(waits, 'utf8')),
  };
}

it('accepts only authenticated target-database TCP readiness before Compose migration admission', () => {
  const compose = parse(readFileSync(`${repositoryRoot}/compose.yaml`, 'utf8')) as {
    services: { postgres: { healthcheck: { test: [string, string] } } };
  };
  const [kind, command] = compose.services.postgres.healthcheck.test;
  expect(kind).toBe('CMD-SHELL');
  for (const phase of ['temporary', 'missing-database', 'bad-password']) {
    const database = fixture(phase);
    expect(database.run(command.replaceAll('$$', '$')).status, phase).not.toBe(0);
  }
  const database = fixture('ready');
  expect(database.run(command.replaceAll('$$', '$')).status).toBe(0);
  expect(database.events()).toEqual([
    {
      kind: 'probe',
      host: 'postgres',
      database: 'openbot',
      user: 'openbot',
      authenticated: true,
      connectTimeout: '2',
      options: '-c statement_timeout=2000',
    },
  ]);
});

it('requires final authenticated TCP readiness for every native PostgreSQL CI service', () => {
  const workflow = parse(
    readFileSync(`${repositoryRoot}/.github/workflows/verify.yml`, 'utf8'),
  ) as {
    jobs: Record<
      string,
      { services: { postgres: { env: Record<string, string>; options: string } } }
    >;
  };
  for (const job of ['postgres-auth', 'postgres-providers', 'postgres-oidc']) {
    const service = workflow.jobs[job]!.services.postgres;
    const command = /--health-cmd "([^"]+)"/u.exec(service.options)?.[1];
    expect(command).toBeDefined();
    expect(fixture('temporary', service.env).run(command!).status, job).not.toBe(0);
    const database = fixture('ready', service.env);
    expect(database.run(command!).status, job).toBe(0);
    expect(database.events()).toEqual([
      {
        kind: 'probe',
        host: 'postgres',
        database: service.env.POSTGRES_DB,
        user: service.env.POSTGRES_USER,
        authenticated: true,
        connectTimeout: '2',
        options: '-c statement_timeout=2000',
      },
    ]);
  }
});

it('waits through temporary initialization before seeding the upgrade database exactly once', () => {
  const workflow = parse(
    readFileSync(`${repositoryRoot}/.github/workflows/verify.yml`, 'utf8'),
  ) as {
    jobs: { compose: { steps: Array<{ name?: string; run?: string }> } };
  };
  const command = workflow.jobs.compose.steps.find(
    (step) => step.name === 'Seed an existing pre-authentication database volume',
  )?.run;
  expect(command).toBeDefined();
  const database = fixture();
  const result = database.run(command!);
  expect(result.error).toBeUndefined();
  expect(result.status).toBe(0);
  expect(database.waits()).toBe(2);
  expect(database.events().map((event) => event.kind)).toEqual(['probe', 'probe', 'probe', 'seed']);
  for (const probe of database.events().filter((event) => event.kind === 'probe'))
    expect(probe).toMatchObject({
      host: 'postgres',
      database: 'openbot',
      user: 'openbot',
      authenticated: true,
      connectTimeout: '2',
      options: '-c statement_timeout=2000',
    });
  const unavailable = fixture('unavailable');
  const failed = unavailable.run(command!);
  expect(failed.error).toBeUndefined();
  expect(failed.status).not.toBe(0);
  expect(unavailable.waits()).toBe(30);
  expect(unavailable.events()).toHaveLength(30);
  expect(unavailable.events().every((event) => event.kind === 'probe')).toBe(true);
});
