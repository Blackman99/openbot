<script lang="ts">
  import type { PageProps } from './$types';
  let { data }: PageProps = $props();
</script>
<svelte:head><title>Message versions · OpenBot</title></svelte:head>
<main>
  <a href={`/app/workspaces/${data.workspace.id}/conversations/${data.conversationId}#message-${data.messageId}`}>Back to conversation</a>
  <h1>Message versions</h1>
  {#each data.versions as version (version.id)}
    <article>
      <h2>Version {version.version}</h2>
      <p>{version.type === 'message.created' ? 'Created' : version.type === 'message.edited' ? 'Edited' : 'Deleted'} by {version.actor.displayName} · <time datetime={version.occurredAt}>{version.occurredAt}</time></p>
      {#if version.type === 'message.deleted'}<p>Deleted message · {version.reason}</p>{:else}<pre>{version.body}</pre>{/if}
    </article>
  {/each}
</main>
<style>
  :global(body) { margin: 0; background: #0d1117; color: #f0f6fc; font-family: Inter, ui-sans-serif, system-ui, sans-serif; }
  main { max-width: 55rem; margin: auto; padding: 2rem; overflow-wrap: anywhere; }
  a { color: #a5d6ff; }
  article { border: 1px solid #30363d; border-radius: .75rem; margin-top: 1.5rem; padding: 1.5rem; }
  pre { font: inherit; white-space: pre-wrap; overflow-wrap: anywhere; }
  @media (max-width: 40rem) { main { padding: 1rem; } article { padding: 1rem; } }
</style>
