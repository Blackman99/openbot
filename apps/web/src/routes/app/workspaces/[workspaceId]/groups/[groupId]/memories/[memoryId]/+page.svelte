<script lang="ts">
  import { enhance } from '$app/forms';
  import MemorySource from '$lib/components/MemorySource.svelte';
  type PageProps = {
    data: {
      workspace: { id: string };
      group: { id: string; name: string };
      grantId: string;
      memory: import('$lib/server/memory-api.js').Memory;
      destinationBots: Array<{ id: string; name: string }>;
    };
    form: {
      action?: string;
      error?: string;
      values?: Record<string, string>;
      preview?: import('$lib/server/memory-api.js').MemoryPromotionPreview;
    } | null;
  };
  let { data, form }: PageProps = $props();
  const confirmKey = crypto.randomUUID();
</script>
<svelte:head><title>Saved memory · {data.group.name} · OpenBot</title></svelte:head>
<main>
  <a href={`/app/workspaces/${data.workspace.id}/groups/${data.group.id}/memories${data.grantId ? `?grantId=${encodeURIComponent(data.grantId)}` : ''}`}>Back to group memories</a>
  <h1>Saved memory</h1>
  <p>{data.group.name}</p>
  <MemorySource memory={data.memory}/>
  <p>This saved version is available only while its current source remains unchanged and visible. Editing appends a new immutable version. Forgetting appends a tombstone and removes the text from lists, search, and new model contexts.</p>
  {#if !data.grantId}
    <section>
      <h2>Edit or forget</h2>
      <form method="POST" action="?/editMemory" use:enhance>
        <input type="hidden" name="expectedVersionId" value={data.memory.versionId} />
        <label for="memory-body">Replacement text</label>
        <textarea id="memory-body" name="body" maxlength="1000" required>{form?.action === 'editMemory' ? form.values?.body ?? data.memory.text : data.memory.text}</textarea>
        <button>Save new version</button>
      </form>
      {#if form?.error && form.action === 'editMemory'}<p role="alert">{form.error}</p>{/if}
      <form method="POST" action="?/forgetMemory" use:enhance>
        <input type="hidden" name="expectedVersionId" value={data.memory.versionId} />
        <button>Forget this memory</button>
      </form>
      {#if form?.error && form.action === 'forgetMemory'}<p role="alert">{form.error}</p>{/if}
    </section>
    <section>
      <h2>Promote to Bot-private memory</h2>
      <p>Preview shows the source, destination Bot, resulting visibility, and content. Promotion requires an explicit confirmation.</p>
      <form method="POST" action="?/previewPromotion" use:enhance>
        <label for="destination-bot">Destination Bot</label>
        <select id="destination-bot" name="destinationBotId" required>
          <option value="">Choose a Bot you can edit</option>
          {#each data.destinationBots as bot (bot.id)}
            <option value={bot.id} selected={form?.values?.destinationBotId === bot.id}>{bot.name}</option>
          {/each}
        </select>
        <button>Preview promotion</button>
      </form>
      {#if form?.error && (form.action === 'previewPromotion' || form.action === 'confirmPromotion')}
        <p role="alert">{form.error}</p>
      {/if}
      {#if form?.preview}
        <article aria-label="Promotion preview">
          <p>Source group: {form.preview.source.groupName}</p>
          <p>Source memory: {form.preview.source.memoryId}</p>
          <p>Destination Bot: {form.preview.destinationBot.name}</p>
          <p>Resulting visibility: {form.preview.visibility.summary}</p>
          <p>Content: {form.preview.content}</p>
        </article>
        <form method="POST" action="?/confirmPromotion" use:enhance>
          <input type="hidden" name="intentId" value={form.preview.id} />
          <input type="hidden" name="idempotencyKey" value={confirmKey} />
          <button>Confirm promotion</button>
        </form>
      {/if}
    </section>
  {/if}
</main>
<style>
  :global(body) { margin: 0; background: #0d1117; color: #f0f6fc; font-family: Inter, ui-sans-serif, system-ui, sans-serif; } main { max-width: 55rem; margin: auto; padding: 2rem; overflow-wrap: anywhere; } a { color: #a5d6ff; }
  form { display: grid; gap: .75rem; margin: 1rem 0; } select, textarea, button { font: inherit; color: inherit; background: #161b22; border: 1px solid #8b949e; border-radius: .4rem; padding: .75rem; } textarea { min-height: 6rem; } button { cursor: pointer; justify-self: start; } [role='alert'] { color: #ffb4ac; }
</style>
