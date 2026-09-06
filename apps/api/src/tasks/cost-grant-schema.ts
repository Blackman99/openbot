// Migration 0048 follows 0047. Published 0017–0047 statement lists stay
// unchanged. Authorized cost grants reuse task_execution_limit_grants so
// the waiting_budget resume overlay keeps seeing one grant row.
export const TASK_COST_GRANT_SCHEMA_STATEMENTS = [
  'ALTER TABLE task_execution_limit_grants DROP CONSTRAINT IF EXISTS task_execution_limit_grants_dimension_check',
  'ALTER TABLE task_execution_limit_grants DROP CONSTRAINT IF EXISTS task_execution_limit_grants_constraint_2',
  `ALTER TABLE task_execution_limit_grants ADD CONSTRAINT task_execution_limit_grants_dimension_check CHECK(dimension IN ('duration','turns','delegationDepth','handoffs','cost'))`,
] as const;

export const COL18_COST_GRANT_REQUIRES_VERSION = '0048_task_cost_grants';
