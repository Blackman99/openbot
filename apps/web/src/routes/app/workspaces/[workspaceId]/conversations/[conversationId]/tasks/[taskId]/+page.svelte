<script lang="ts">
  import TaskSummary from '$lib/components/TaskSummary.svelte';
  import type { PageProps } from './$types';
  let { data }: PageProps = $props();
  let base = $derived(`/app/workspaces/${data.workspace.id}/conversations/${data.conversation.id}`);
</script>
<svelte:head><title>Task for {data.task.bot.name} · OpenBot</title></svelte:head>
<main>
  <a href={`${base}/tasks`}>Back to tasks</a>
  <h1>Saved task</h1>
  <nav aria-label="Task navigation"><a href={`${base}/tasks/${data.task.id}`} data-sveltekit-reload>Refresh task</a><a href={base}>Open conversation</a></nav>
  <TaskSummary task={data.task} conversationBase={base} showLink={false} />
</main>
<style>
  :global(body) { margin: 0; background: #0d1117; color: #f0f6fc; font-family: Inter, ui-sans-serif, system-ui, sans-serif; }
  main { max-width: 55rem; margin: auto; padding: 2rem; overflow-wrap: anywhere; }
  a { color: #a5d6ff; } nav { display: flex; flex-wrap: wrap; gap: 1.5rem; margin: 1rem 0; }
  @media (max-width: 40rem) { main { padding: 1rem; } }
</style>
