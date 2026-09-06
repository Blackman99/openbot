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
  const pending = $derived(data.pendingRevocations ?? []);
  const retainKey = crypto.randomUUID();
  const revokeKey = crypto.randomUUID();
</script>
<svelte:head><title>Group memories · {data.group.name} · OpenBot</title></svelte:head>
<main>
  <a href={`/app/workspaces/${data.workspace.id}/groups/${data.group.id}`}>Back to group</a>
  <h1>Group memories</h1><p>{data.group.name}</p>
  <p>Saved sources stay in this group. A source edit, deletion or purge makes its saved version unavailable until you retain it as an independent memory or confirm revocation.</p>
  {#if pending.length && !grantId}
    <section>
      <h2>Pending revocation</h2>
      <p>These memories are excluded from lists, search, and new model contexts until you retain or revoke them.</p>
      {#each pending as item (item.id)}
        <article aria-label="Pending memory revocation">
          <pre>{item.text}</pre>
          <p>Memory version {item.version} · Source {item.reason === 'source_purged' ? 'purged' : 'deleted'}</p>
          {#if form?.error && (form.action === 'retainMemory' || form.action === 'revokeMemory') && form.values?.memoryId === item.id}<p role="alert">{form.error}</p>{/if}
          <form method="POST" action="?/retainMemory" use:enhance>
            <input type="hidden" name="memoryId" value={item.id} />
            <input type="hidden" name="expectedVersionId" value={item.versionId} />
            <input type="hidden" name="idempotencyKey" value={retainKey} />
            <button>Retain as independent memory</button>
          </form>
          <form method="POST" action="?/revokeMemory" use:enhance>
            <input type="hidden" name="memoryId" value={item.id} />
            <input type="hidden" name="expectedVersionId" value={item.versionId} />
            <input type="hidden" name="idempotencyKey" value={revokeKey} />
            <button>Confirm revocation</button>
          </form>
        </article>
      {/each}
    </section>
  {/if}
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
  article { border: 1px solid #30363d; border-radius: .75rem; padding: 1.25rem; margin: 1rem 0; } pre { white-space: pre-wrap; font: inherit; }
  button { cursor: pointer; justify-self: start; } [role='alert'] { color: #ffb4ac; }
</style>
