export const BOT_LIFECYCLE_SCHEMA_STATEMENTS = [
  "ALTER TABLE bots ADD COLUMN lifecycle_state TEXT NOT NULL DEFAULT 'active' CHECK (lifecycle_state IN ('active','archived','deleted'))",
  'ALTER TABLE bots ADD COLUMN deleted_at TIMESTAMPTZ',
  'ALTER TABLE bots ADD COLUMN recovery_deadline TIMESTAMPTZ',
  "ALTER TABLE bots ADD COLUMN pre_deleted_state TEXT CHECK (pre_deleted_state IS NULL OR pre_deleted_state IN ('active','archived'))",
  `ALTER TABLE bots ADD CONSTRAINT bots_deletion_window CHECK (
    (lifecycle_state='deleted' AND deleted_at IS NOT NULL AND recovery_deadline IS NOT NULL
      AND pre_deleted_state IS NOT NULL AND recovery_deadline > deleted_at)
    OR (lifecycle_state<>'deleted' AND deleted_at IS NULL AND recovery_deadline IS NULL AND pre_deleted_state IS NULL)
  )`,
] as const;
