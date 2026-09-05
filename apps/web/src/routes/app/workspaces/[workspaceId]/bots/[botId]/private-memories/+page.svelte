<script lang="ts">
  type PageProps = {
    data: {
      workspace: { id: string };
      bot: { id: string; name: string };
      memories: Array<{
        id: string;
        sourceGroupId: string;
        sourceMemoryId: string;
        approver: { displayName: string };
        approvedAt: string;
        text: string;
      }>;
    };
  };
  let { data }: PageProps = $props();
</script>
<svelte:head><title>Bot-private memories · {data.bot.name} · OpenBot</title></svelte:head>
<main>
  <a href={`/app/workspaces/${data.workspace.id}/bots/${data.bot.id}`}>Back to Bot</a>
  <h1>Bot-private memories</h1>
  <p>{data.bot.name}</p>
  <p>These memories are available to this Bot across its conversations and groups. Other Bots cannot list, search, or receive them.</p>
  {#each data.memories as memory (memory.id)}
    <article>
      <p>{memory.text}</p>
      <p>Approved by {memory.approver.displayName} at {memory.approvedAt}</p>
      <p>Source group {memory.sourceGroupId} · source memory {memory.sourceMemoryId}</p>
    </article>
  {:else}
    <p>No Bot-private memories.</p>
  {/each}
</main>
<style>
  :global(body) { margin: 0; background: #0d1117; color: #f0f6fc; font-family: Inter, ui-sans-serif, system-ui, sans-serif; } main { max-width: 55rem; margin: auto; padding: 2rem; overflow-wrap: anywhere; } a { color: #a5d6ff; }
</style>
