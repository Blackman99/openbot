export const GROUP_ARCHIVE_SCHEMA_STATEMENTS = [
  'ALTER TABLE groups ADD COLUMN archived_at TIMESTAMPTZ',
  'ALTER TABLE groups ADD COLUMN max_concurrent_runs INTEGER',
] as const;

export const API03_GROUP_ARCHIVE_REQUIRES_VERSION = '0049_group_archive';
