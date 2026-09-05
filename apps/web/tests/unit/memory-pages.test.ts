import { render } from 'svelte/server';
import { describe, expect, it } from 'vitest';
import MemoriesPage from '../../src/routes/app/workspaces/[workspaceId]/groups/[groupId]/memories/+page.svelte';
import MemoryPage from '../../src/routes/app/workspaces/[workspaceId]/groups/[groupId]/memories/[memoryId]/+page.svelte';
import { memory, group, grant, user, workspace } from '../fixtures/memories.js';
const data = {
  user,
  workspace,
  workspaces: [workspace],
  group,
  grants: [grant],
  grantId: '',
  memoryPage: { memories: [memory], nextAfter: null },
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
        params,
      },
    }).body;
    expect(html).toContain(memory.source.eventId);
    expect(html).toContain(memory.source.creationEventId);
    expect(html).toContain(
      `?messageId=${memory.source.messageId}#message-${memory.source.messageId}`,
    );
    expect(html).toContain('Memory version 1');
    expect(html).toMatch(/&lt;script(?:>|&gt;)untrusted&lt;\/script(?:>|&gt;)/u);
    expect(html).not.toContain('<script>untrusted');
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
});
