import { DataType, newDb } from 'pg-mem';

function ftsTerms(query: string): string[] {
  return query
    .split('|')
    .map((term) => term.trim())
    .filter(Boolean);
}

function ftsTokens(text: string): Set<string> {
  return new Set(text.toLowerCase().match(/[a-z0-9]+/gu) ?? []);
}

export function registerKnowledgeFtsStubs(database: ReturnType<typeof newDb>) {
  // Token match, not ILIKE substring. "somewhat" must not match tsquery "what".
  database.public.registerFunction({
    name: 'knowledge_fts_match',
    args: [DataType.text, DataType.text],
    returns: DataType.bool,
    implementation: (text: string, query: string) => {
      const tokens = ftsTokens(text);
      return ftsTerms(query).some((term) => tokens.has(term));
    },
  });
  database.public.registerFunction({
    name: 'knowledge_fts_rank',
    args: [DataType.text, DataType.text],
    returns: DataType.float,
    implementation: (text: string, query: string) => {
      const tokens = ftsTokens(text);
      return ftsTerms(query).filter((term) => tokens.has(term)).length;
    },
  });
}

export function registerAdvisoryXactLockStub(database: ReturnType<typeof newDb>) {
  // pg-mem checks authorization/query behavior only. PostgreSQL runtime tests prove lock ordering.
  database.public.registerFunction({
    name: 'pg_advisory_xact_lock',
    args: [DataType.integer, DataType.integer],
    returns: DataType.integer,
    implementation: () => 0,
  });
}

export function newProviderDatabase() {
  const database = newDb({ noAstCoverageCheck: true });
  registerAdvisoryXactLockStub(database);
  registerKnowledgeFtsStubs(database);
  return database;
}
