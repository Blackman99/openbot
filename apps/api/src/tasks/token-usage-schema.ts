// Migration 0041 follows 0040. Published 0017/0022/0023/0033/0034/0035/0036/0037/0038/0039/0040
// statement lists stay unchanged. Provider usage is actual; local counts set
// estimated. Tokens and the flag stay paired.
export const TASK_TOKEN_USAGE_SCHEMA_STATEMENTS = [
  'ALTER TABLE task_runs ADD COLUMN usage_estimated BOOLEAN',
  'UPDATE task_runs SET usage_estimated=FALSE WHERE input_tokens IS NOT NULL AND usage_estimated IS NULL',
  `ALTER TABLE task_runs ADD CONSTRAINT task_runs_usage_estimated CHECK (
    (input_tokens IS NULL AND output_tokens IS NULL AND usage_estimated IS NULL)
    OR (input_tokens IS NOT NULL AND output_tokens IS NOT NULL AND usage_estimated IS NOT NULL)
  )`,
] as const;

export const COL17_TOKEN_USAGE_REQUIRES_VERSION = '0041_task_token_usage';
