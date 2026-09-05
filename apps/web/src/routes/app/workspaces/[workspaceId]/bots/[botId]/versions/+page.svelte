<script lang="ts">
  import type { PageProps } from './$types';
  let { data }: PageProps = $props();
  const base = $derived(`/app/workspaces/${data.workspace.id}/bots/${data.bot.id}`);
</script>
<svelte:head><title>Version history · {data.bot.name} · OpenBot</title></svelte:head>
<main>
  <a href={base}>Back to Bot</a>
  <h1>Version history</h1>
  <p>{data.bot.name} · Immutable configurations, newest first.</p>
  {#if data.canEdit}<p><a href={`${base}/edit`}>Edit configuration</a></p>{/if}
  <nav aria-label="History pages"><a href={`${base}/versions?limit=${data.limit}`}>Latest versions</a>{#if data.history.nextBefore}<a href={`${base}/versions?before=${data.history.nextBefore}&limit=${data.limit}`}>Older versions</a>{/if}</nav>
  {#each data.history.versions as version (version.id)}
    <article>
      <h2><a href={`${base}/versions/${version.id}`}>Version {version.number}</a>{version.id === data.history.currentVersionId ? ' · Current' : ''}</h2>
      <p>{version.author.displayName} · <time datetime={version.createdAt}>{version.createdAt}</time></p>
      <p>{version.rationale}</p>
    </article>
  {:else}<p>No versions on this page.</p>{/each}
  {#if data.history.versions.length}
    <section aria-labelledby="compare-heading">
      <h2 id="compare-heading">Compare versions</h2>
      <form method="GET" action={`${base}/versions/compare`}>
        <label for="from-version">From version</label><select id="from-version" name="fromVersionId" value={data.history.versions.at(-1)?.id}>
          {#each data.history.versions as version (version.id)}<option value={version.id}>Version {version.number} · {version.rationale}</option>{/each}
        </select>
        <label for="to-version">To version</label><select id="to-version" name="toVersionId" value={data.history.versions[0].id}>
          {#each data.history.versions as version (version.id)}<option value={version.id}>Version {version.number} · {version.rationale}</option>{/each}
        </select>
        <button>Compare versions</button>
      </form>
      <p>Open an older version to compare it with the current version across pages.</p>
    </section>
  {/if}
</main>
<style>
  :global(body) { margin: 0; background: #0d1117; color: #f0f6fc; font-family: Inter, ui-sans-serif, system-ui, sans-serif; }
  main { max-width: 55rem; margin: auto; padding: 2rem; overflow-wrap: anywhere; } a { color: #a5d6ff; }
  nav { display: flex; gap: 1.5rem; flex-wrap: wrap; } article, section { padding: 1.5rem; border: 1px solid #30363d; border-radius: .75rem; margin-top: 1.5rem; }
  form { display: grid; gap: .75rem; } select, button { font: inherit; padding: .75rem; border: 1px solid #526171; border-radius: .4rem; color: inherit; background: #161b22; min-width: 0; } button { cursor: pointer; }
  @media (max-width: 40rem) { main, article, section { padding: 1rem; } }
</style>
