// Migration 0032 follows memory revisions 0031. Document locators and
// immutable file versions extend the existing knowledge chunk table.
export const DOCUMENT_KNOWLEDGE_SCHEMA_STATEMENTS = [
  `ALTER TABLE knowledge_chunks DROP CONSTRAINT IF EXISTS knowledge_chunks_locator_kind_check`,
  `ALTER TABLE knowledge_chunks DROP CONSTRAINT IF EXISTS knowledge_chunks_constraint_3`,
  `ALTER TABLE knowledge_chunks ADD CONSTRAINT knowledge_chunks_locator_kind_check CHECK (locator_kind IN ('line','row','page','paragraph','cells'))`,
  `ALTER TABLE knowledge_chunks ADD COLUMN locator_ref TEXT`,
] as const;

export const DOCUMENT_KNOWLEDGE_POSTGRES_GUARDS = [] as const;
