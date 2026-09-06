<script lang="ts">
  import TaskSummary from '$lib/components/TaskSummary.svelte';
  import TaskRunSummary from '$lib/components/TaskRunSummary.svelte';
  import type { PageProps } from './$types';
  let { data }: PageProps = $props();
  let base = $derived(`/app/workspaces/${data.workspace.id}/conversations/${data.conversation.id}`);
  let taskBase = $derived(`${base}/tasks/${data.task.id}`);
</script>
<svelte:head><title>Attempt history · OpenBot</title></svelte:head>
<main>
  <a href={taskBase}>Back to task</a>
  <h1>Attempt history</h1>
  <TaskSummary task={data.task} conversationBase={base} showLink={false} />
  <h2>Saved attempts on this page</h2>
  {#each data.runs as run (run.id)}<TaskRunSummary {run} conversationBase={base} />{:else}<p>No attempts on this page.</p>{/each}
  <nav aria-label="Attempt pages">
    <a href={taskBase} data-sveltekit-reload>Refresh current task</a>
    {#if data.nextCursor}<a href={`${taskBase}/runs?cursor=${encodeURIComponent(data.nextCursor)}&limit=${data.limit}`}>Older attempts</a>{/if}
  </nav>
</main>
<style>
  :global(body) { margin: 0; background: #0d1117; color: #f0f6fc; font-family: Inter, ui-sans-serif, system-ui, sans-serif; }
  main { max-width: 55rem; margin: auto; padding: 2rem; overflow-wrap: anywhere; }
  h2 { font-size: 1.25rem; margin-top: 2rem; }
  a { color: #a5d6ff; } nav { display: flex; flex-wrap: wrap; gap: 1.5rem; margin: 1rem 0; }
  @media (max-width: 40rem) { main { padding: 1rem; } }
</style>
