import { describe, expect, it } from 'vitest';
import { MIGRATION_VERSIONS } from '../../src/database/migrations.js';
import {
  COL18_MODEL_PRICE_REQUIRES_VERSION,
  MODEL_PRICE_SCHEMA_STATEMENTS,
} from '../../src/tasks/model-price-schema.js';

describe('COL-18 model price schema slice', () => {
  const sql = MODEL_PRICE_SCHEMA_STATEMENTS.join('\n');

  it('is the next ordered ledger after handoff and versions prices without GRANT', () => {
    expect(COL18_MODEL_PRICE_REQUIRES_VERSION).toBe('0045_model_price_versions');
    expect(MIGRATION_VERSIONS).toContain('0044_task_lead_handoffs');
    expect(MIGRATION_VERSIONS.at(-1)).toBe('0050_workspace_event_stream');
    expect(sql).toContain('CREATE TABLE model_price_versions');
    expect(sql).toContain('superseded_at');
    expect(sql).toContain('ALTER TABLE task_runs ADD COLUMN price_version_id');
    expect(sql).not.toContain('length(');
    expect(sql).not.toContain('INSERT INTO openbot_schema_migrations');
    expect(sql).not.toContain('GRANT');
    expect(sql).not.toContain('PUBLIC');
  });
});
