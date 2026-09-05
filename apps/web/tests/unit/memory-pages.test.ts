import { render } from 'svelte/server';
import { describe, expect, it } from 'vitest';
import MemoriesPage from '../../src/routes/app/workspaces/[workspaceId]/groups/[groupId]/memories/+page.svelte';
import MemoryPage from '../../src/routes/app/workspaces/[workspaceId]/groups/[groupId]/memories/[memoryId]/+page.svelte';
import PrivateMemoriesPage from '../../src/routes/app/workspaces/[workspaceId]/bots/[botId]/private-memories/+page.svelte';
import CandidatesPage from '../../src/routes/app/workspaces/[workspaceId]/conversations/[conversationId]/memory-candidates/+page.svelte';
import {
  candidate,
  conversation,
  memory,
  group,
  grant,
  user,
  workspace,
} from '../fixtures/memories.js';
import { WORKSPACE_FACT_VISIBILITY_SUMMARY } from '../../src/lib/server/memory-api.js';
import { summary } from '../fixtures/bots.js';
const data = {
  user,
  workspace,
  workspaces: [workspace],
  group,
  grants: [grant],
  grantId: '',
  memoryPage: { memories: [memory], nextAfter: null },
  destinationBots: [{ id: '3c661304-a1bc-4767-9a87-c47de763f749', name: 'Private helper' }],
};
const params = { workspaceId: workspace.id, groupId: group.id, memoryId: memory.id };
describe('Memory pages', () => {
  it('renders an exact grant selector and sends search text in a POST form', () => {
    const html = render(MemoriesPage, { props: { data, form: null, params } }).body;
    expect(html).toContain('View memories available to');
    expect(html).toContain(`value="${grant.id}"`);
    expect(html).toContain('method="POST" action="?/search"');
    expect(html).toContain('Search memory text');
    expect(html).toContain('Confidence 0.5 (human estimate)');
  });
  it('shows provenance and an exact current-message locator, escaping source markup', () => {
    const html = render(MemoryPage, {
      props: {
        data: { ...data, memory: { ...memory, text: '<script>untrusted</script>' } },
        form: null,
      },
    }).body;
    expect(html).toContain(memory.source.eventId);
    expect(html).toContain(memory.source.creationEventId);
    expect(html).toContain(
      `?messageId=${memory.source.messageId}#message-${memory.source.messageId}`,
    );
    expect(html).toContain('Memory version 1');
    expect(html).toContain('Promote to Bot-private memory');
    expect(html).toContain('Preview promotion');
    expect(html).toContain('Private helper');
    expect(html).toMatch(/&lt;script(?:>|&gt;)untrusted&lt;\/script(?:>|&gt;)/u);
    expect(html).not.toContain('<script>untrusted');
  });
  it('shows source, destination Bot, visibility and content before confirmation', () => {
    const html = render(MemoryPage, {
      props: {
        data: { ...data, memory },
        form: {
          action: 'previewPromotion',
          values: { destinationBotId: data.destinationBots[0]!.id },
          preview: {
            id: memory.id,
            expiresAt: memory.createdAt,
            source: {
              groupId: group.id,
              groupName: group.name,
              memoryId: memory.id,
              text: memory.text,
            },
            destinationBot: data.destinationBots[0]!,
            visibility: {
              kind: 'bot-private',
              botId: data.destinationBots[0]!.id,
              summary:
                'This Bot can use this memory across its conversations and groups. Other Bots cannot list, search, or receive it.',
            },
            content: memory.text,
          },
        },
      },
    }).body;
    expect(html).toContain('Source group:');
    expect(html).toContain(group.name);
    expect(html).toContain('Destination Bot: Private helper');
    expect(html).toContain('Resulting visibility:');
    expect(html).toContain('Content:');
    expect(html).toContain('Confirm promotion');
  });
  it('does not replace a failed scoped search with the broader page results', () => {
    const html = render(MemoriesPage, {
      props: {
        data,
        form: {
          action: 'search',
          values: { query: 'needle', grantId: grant.id },
          conflict: false,
          error: 'Access changed',
        },
        params,
      },
    }).body;
    expect(html).toContain('Access changed');
    expect(html).not.toContain(memory.text);
    expect(html).not.toContain('Saved by');
  });
  it('lists destination Bot-private memories and shows an empty state for every other Bot', () => {
    const listed = render(PrivateMemoriesPage, {
      props: {
        data: {
          workspace,
          bot: { id: summary.id, name: summary.name },
          memories: [
            {
              id: memory.id,
              sourceGroupId: group.id,
              sourceMemoryId: memory.id,
              approver: { displayName: user.displayName },
              approvedAt: memory.createdAt,
              text: memory.text,
            },
          ],
        },
      },
    }).body;
    expect(listed).toContain('Bot-private memories');
    expect(listed).toContain(summary.name);
    expect(listed).toContain(memory.text);
    expect(listed).toContain(group.id);
    expect(listed).toContain('across its conversations and groups');
    const empty = render(PrivateMemoriesPage, {
      props: {
        data: {
          workspace,
          bot: { id: summary.id, name: 'Other isolated' },
          memories: [],
        },
      },
    }).body;
    expect(empty).toContain('No Bot-private memories.');
    expect(empty).not.toContain(memory.text);
  });
  it('lists pending candidates and requires a separate confirmation for a wider destination', () => {
    const html = render(CandidatesPage, {
      props: {
        params: { workspaceId: workspace.id, conversationId: conversation.id },
        data: {
          user,
          workspace: { ...workspace, role: 'owner' },
          workspaces: [{ ...workspace, role: 'owner' }],
          conversation,
          candidatePage: { candidates: [candidate], nextAfter: null },
          destinationGroups: [group],
          destinationBots: [summary],
          canApproveWorkspace: true,
        },
        form: {
          action: 'previewCandidate',
          values: { candidateId: candidate.id, destination: `workspace:${workspace.id}` },
          conflict: false,
          error: '',
          preview: {
            id: candidate.id,
            expiresAt: candidate.createdAt,
            content: candidate.body,
            destination: { kind: 'workspace', id: workspace.id },
            visibility: {
              kind: 'workspace',
              id: workspace.id,
              summary: WORKSPACE_FACT_VISIBILITY_SUMMARY,
            },
            disclosureVersion: 'mem-03-audience-v1',
          },
        },
      },
    }).body;
    expect(html).toContain('Memory review inbox');
    expect(html).toContain(candidate.body);
    expect(html).toContain('Approve into this group');
    expect(html).toContain('Preview wider approval');
    expect(html).toContain('Confirm this approval');
    expect(html).toContain(WORKSPACE_FACT_VISIBILITY_SUMMARY);
    expect(html).toContain('Reject candidate');
  });
});
