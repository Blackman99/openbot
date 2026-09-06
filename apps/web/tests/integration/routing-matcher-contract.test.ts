import { describe, expect, it } from 'vitest';
import { chooseLead } from '../../../api/src/routing/matcher.js';
import { RoutingDecisionApiClient } from '../../src/lib/server/routing-decision-api.js';
import { grant, lead, routedTask, token, workspace } from '../fixtures/routing.js';

describe('API matcher to strict Web decoder contract', () => {
  it.each(['mention', 'default', 'local-match'] as const)(
    'accepts all eight maximum-size public personas and expanded Unicode evidence for %s',
    async (reason) => {
      const name = 'Ａ'.repeat(100);
      const roleDescription = 'ﷺ'.repeat(200);
      const description = Array.from({ length: 2000 }, (_, i) =>
        String.fromCodePoint(0x4e00 + i),
      ).join('');
      const candidates = Array.from({ length: 8 }, (_, index) => ({
        ...lead,
        botId: `${String(index + 1).padStart(8, '0')}-ce23-4d77-9c72-fb4e9d01766c`,
        grantId: `${String(index + 11).padStart(8, '0')}-ce23-4d77-9c72-fb4e9d01766c`,
        versionId: `${String(index + 21).padStart(8, '0')}-ce23-4d77-9c72-fb4e9d01766c`,
        name,
        roleDescription,
        description,
      }));
      const decision = chooseLead({
        body: [name, roleDescription, description].join(' '),
        candidates,
        ...(reason === 'mention' ? { mentionedGrantId: candidates[7]!.grantId } : {}),
        ...(reason === 'default' ? { defaultGrantId: candidates[6]!.grantId } : {}),
      });
      expect(decision.reason).toBe(reason);
      expect(decision.candidates.every((candidate) => candidate.matchedTerms.length > 2000)).toBe(
        true,
      );
      const payload = JSON.stringify({ routing: decision });
      expect(new TextEncoder().encode(payload).byteLength).toBeLessThan(1024 * 1024);
      const client = new RoutingDecisionApiClient(
        async () => new Response(payload),
        'http://api.example',
        'https://web.example',
      );
      expect(
        await client.getForTask(token, workspace.id, grant.conversationId, {
          ...routedTask,
          routing: { algorithm: 'local-terms-v1', reason },
        }),
      ).toEqual({ status: 'available', value: decision });
    },
  );
});
