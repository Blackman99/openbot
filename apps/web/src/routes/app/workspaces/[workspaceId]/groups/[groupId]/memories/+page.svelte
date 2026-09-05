<script lang="ts">
  import { enhance } from '$app/forms';
  import MemorySource from '$lib/components/MemorySource.svelte';
  import type { PageProps } from './$types';
  let { data, form }: PageProps = $props();
  const base = $derived(`/app/workspaces/${data.workspace.id}/groups/${data.group.id}/memories`);
  const searching = $derived(form?.action === 'search');
  const page = $derived(searching && form && 'memoryPage' in form ? form.memoryPage ?? { memories: [], nextAfter: null } : form?.error ? { memories: [], nextAfter: null } : data.memoryPage);
  const grantId = $derived(form?.values.grantId ?? data.grantId);
  const scopeQuery = $derived(grantId ? `?grantId=${encodeURIComponent(grantId)}` : '');
</script>
<svelte:head><title>Group memories · {data.group.name} · OpenBot</title></svelte:head>
<main>
  <a href={`/app/workspaces/${data.workspace.id}/groups/${data.group.id}`}>Back to group</a>
  <h1>Group memories</h1><p>{data.group.name}</p>
  <p>Saved sources stay in this group. A source edit, deletion or purge makes its saved version unavailable.</p>
  <form method="GET" action={base}>
    <label for="memory-scope">View memories available to</label>
    <select id="memory-scope" name="grantId" value={grantId}>
      <option value="">Current group members</option>
      {#each data.grants as grant (grant.id)}<option value={grant.id}>{grant.bot.name} · joined {grant.joined.at}</option>{/each}
    </select><button>Apply scope</button>
  </form>
  <form method="POST" action="?/search" use:enhance>
    <input type="hidden" name="grantId" value={grantId} />
    <label for="memory-query">Search memory text</label><input id="memory-query" name="query" maxlength="200" value={form?.values.query ?? ''} />
    <button>Search memories</button>
  </form>
  <a href={`${base}${scopeQuery}`}>Clear search and refresh</a>
  {#if form?.error}<p role="alert">{form.error}</p>{/if}
  {#each page.memories as memory (memory.id)}
    <MemorySource {memory}/><a href={`${base}/${memory.id}${scopeQuery}`}>Inspect memory</a>
  {:else}<p>No current memories in this scope.</p>{/each}
  {#if page.nextAfter}
    {#if searching}<form method="POST" action="?/search" use:enhance><input type="hidden" name="query" value={form?.values.query ?? ''}/><input type="hidden" name="grantId" value={grantId}/><input type="hidden" name="after" value={page.nextAfter}/><button>Next search page</button></form>
    {:else}<a href={`${base}?after=${page.nextAfter}${grantId ? `&grantId=${encodeURIComponent(grantId)}` : ''}`}>Next memory page</a>{/if}
  {/if}
</main>
<style>
  :global(body) { margin: 0; background: #0d1117; color: #f0f6fc; font-family: Inter, ui-sans-serif, system-ui, sans-serif; }
  main { max-width: 55rem; margin: auto; padding: 2rem; overflow-wrap: anywhere; } a { color: #a5d6ff; }
  form { display: grid; gap: .75rem; margin: 1rem 0; } input, select, button { font: inherit; color: inherit; background: #161b22; border: 1px solid #8b949e; border-radius: .4rem; padding: .75rem; min-width: 0; }
  button { cursor: pointer; justify-self: start; } [role='alert'] { color: #ffb4ac; }
</style>
