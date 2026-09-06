<script lang="ts">
  import type { PageProps } from './$types';
  let { data }: PageProps = $props();
  const base = $derived(`/app/workspaces/${data.workspace.id}/groups/${data.group.id}/bots`);
</script>
<svelte:head><title>Allowed context · {data.grant.bot.name} · OpenBot</title></svelte:head>
<main>
  <a href={base}>Back to group Bots</a>
  <h1>Allowed context for {data.grant.bot.name}</h1>
  <p>{data.group.name} · Read-only context for this active membership.</p>
  <p>Only eligible human messages and their current permitted versions appear. Bot settings and model credentials use separate permissions.</p>
  <a href={`${base}/${data.grant.id}/context`}>Refresh context</a>
  {#if data.context.messages.length === 0}<p>No messages within this history boundary yet.</p>{/if}
  {#each data.context.messages as message (message.id)}
    <article aria-label={`Message by ${message.author.displayName}`}>
      <h2>{message.author.displayName}</h2>
      <p><time datetime={message.createdAt}>{message.createdAt}</time></p>
      {#if message.deleted}<p>Deleted message</p><p>{message.reason}</p>{:else}<pre>{message.body}</pre>{/if}
    </article>
  {/each}
  {#if data.context.nextCursor}<a href={`${base}/${data.grant.id}/context?cursor=${encodeURIComponent(data.context.nextCursor)}`}>Next messages</a>{/if}
</main>
<style>
  :global(body) { margin: 0; background: #0d1117; color: #f0f6fc; font-family: Inter, ui-sans-serif, system-ui, sans-serif; }
  main { max-width: 52rem; margin: auto; padding: 2rem; overflow-wrap: anywhere; }
  a { color: #a5d6ff; }
  article { border: 1px solid #30363d; border-radius: .75rem; padding: 1.5rem; margin: 1.5rem 0; }
  h2 { font-size: 1rem; }
  pre { white-space: pre-wrap; overflow-wrap: anywhere; font: inherit; }
  @media (max-width: 40rem) { main { padding: 1rem; } article { padding: 1rem; } }
</style>
