import { afterEach, describe, expect, it } from 'vitest';
import { buildApp } from '../../src/app.js';
import { LocalAuthService } from '../../src/auth/service.js';
import { PostgresAuthRepository } from '../../src/auth/postgres-auth-repository.js';
import { ModelPriceService } from '../../src/tasks/model-price-service.js';
import { botAclFixture } from '../helpers/bot-acl-fixture.js';

describe('COL-18 model price versions', () => {
  const cleanup: Array<() => Promise<unknown>> = [];
  afterEach(async () => {
    for (const close of cleanup.splice(0).reverse()) await close();
  });

  it('lets only workspace admins create and supersede a price version', async () => {
    const f = await botAclFixture(cleanup);
    const prices = new ModelPriceService(f.pool);
    const app = buildApp({
      auth: new LocalAuthService(new PostgresAuthRepository(f.pool)),
      modelPrices: prices,
      readiness: { check: async () => ({ database: 'ready', migrations: 'current' }) },
    });
    cleanup.push(() => app.close());
    const member = await f.addUser('member');
    const body = {
      connectionId: f.model.id,
      modelId: f.model.modelId,
      inputMicrosPerMillion: 2_000_000,
      outputMicrosPerMillion: 8_000_000,
    };
    const denied = await app.inject({
      method: 'PUT',
      url: `/api/v1/workspaces/${f.owner.workspace.id}/model-prices`,
      headers: { ...member.headers, origin: 'http://localhost:3000' },
      payload: body,
    });
    expect(denied.statusCode).toBe(403);
    expect(await prices.list(f.owner.user.id, f.owner.workspace.id)).toEqual([]);
    const created = await app.inject({
      method: 'PUT',
      url: `/api/v1/workspaces/${f.owner.workspace.id}/model-prices`,
      headers: f.headers,
      payload: body,
    });
    expect(created.statusCode).toBe(200);
    expect(created.json().price).toMatchObject({
      connectionId: f.model.id,
      modelId: 'test-model',
      inputMicrosPerMillion: 2_000_000,
      outputMicrosPerMillion: 8_000_000,
    });
    const next = await prices.supersede(f.owner.user.id, f.owner.workspace.id, {
      ...body,
      inputMicrosPerMillion: 3_000_000,
    });
    expect(next.inputMicrosPerMillion).toBe(3_000_000);
    expect(await prices.list(member.id, f.owner.workspace.id)).toMatchObject([
      { id: next.id, inputMicrosPerMillion: 3_000_000 },
    ]);
    expect(
      (
        await f.pool.query(
          'SELECT superseded_at IS NULL AS active FROM model_price_versions WHERE workspace_id=$1 ORDER BY created_at,id',
          [f.owner.workspace.id],
        )
      ).rows,
    ).toEqual([{ active: false }, { active: true }]);
  });
});
