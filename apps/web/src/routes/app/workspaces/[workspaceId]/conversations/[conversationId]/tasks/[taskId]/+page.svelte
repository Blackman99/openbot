<script lang="ts">
  import RoutingDecision from '$lib/components/RoutingDecision.svelte';
  import { enhance } from '$app/forms';
  import type { SubmitFunction } from '@sveltejs/kit';
  import TaskSummary from '$lib/components/TaskSummary.svelte';
  import type { PageProps } from './$types';
  let { data, form }: PageProps = $props();
  let submitting = $state(false);
  let transportError = $state('');
  let unconfirmed = $state<Record<string, string> | null>(null);
  let values = $derived(unconfirmed ?? form?.values ?? {});
  let uncertain = $derived(Boolean(unconfirmed) || Boolean(form?.uncertain));
  let canConfirm = $derived(uncertain && data.user.id === data.task.executionUser.id && Boolean(values.idempotencyKey && values.expectedRunId));
  let base = $derived(`/app/workspaces/${data.workspace.id}/conversations/${data.conversation.id}`);
  const retry: SubmitFunction = ({ formData, cancel }) => {
    if (submitting) { cancel(); return; }
    const captured: Record<string, string> = {};
    for (const key of ['idempotencyKey', 'expectedRunId']) {
      const value = formData.get(key);
      if (typeof value === 'string') captured[key] = value;
    }
    submitting = true;
    transportError = '';
    return async ({ result, update }) => {
      const preserve = () => {
        unconfirmed = captured;
        transportError = 'The retry could not be confirmed. Confirm this unchanged retry to check its saved attempt.';
      };
      try {
        if (result.type === 'error') { preserve(); return; }
        await update({ reset: false, invalidateAll: false });
        unconfirmed = null;
      } catch { preserve(); }
      finally { submitting = false; }
    };
  };
</script>
<svelte:head><title>Task for {data.task.bot.name} · OpenBot</title></svelte:head>
<main>
  <a href={`${base}/tasks`}>Back to tasks</a>
  <h1>Saved task</h1>
  <nav aria-label="Task navigation"><a href={`${base}/tasks/${data.task.id}`} data-sveltekit-reload>Refresh task</a><a href={base}>Open conversation</a></nav>
  <TaskSummary task={data.task} conversationBase={base} showLink={false} />
  {#if data.routingDecision}<RoutingDecision decision={data.routingDecision} />{/if}
  {#if transportError || form?.error}<p role="alert">{transportError || form?.error}</p>{/if}
  {#if data.canRetry || canConfirm}
    <section aria-labelledby="retry-heading">
      <h2 id="retry-heading">Retry this task</h2>
      <p>Retry uses this task's Bot configuration and respects current message edits and deletions. Earlier attempts stay available.</p>
      <form method="POST" action={`${base}/tasks/${data.task.id}?/retry`} use:enhance={retry}>
        <input type="hidden" name="idempotencyKey" value={values.idempotencyKey ?? data.idempotencyKey} />
        <input type="hidden" name="expectedRunId" value={values.expectedRunId ?? data.task.runs[0]?.id} />
        {#if uncertain}<p>The original retry request is preserved until its outcome is confirmed.</p>{/if}
        <button disabled={submitting || form?.conflict}>{submitting ? 'Confirming…' : uncertain ? 'Confirm unchanged retry' : 'Retry failed task'}</button>
      </form>
    </section>
  {/if}
</main>
<style>
  :global(body) { margin: 0; background: #0d1117; color: #f0f6fc; font-family: Inter, ui-sans-serif, system-ui, sans-serif; }
  main { max-width: 55rem; margin: auto; padding: 2rem; overflow-wrap: anywhere; }
  a { color: #a5d6ff; } nav { display: flex; flex-wrap: wrap; gap: 1.5rem; margin: 1rem 0; }
  section { margin-top: 1.5rem; } h2 { font-size: 1.25rem; }
  button { padding: .75rem; border: 1px solid #526171; border-radius: .4rem; font: inherit; background: #9ed0ff; color: #0d1117; cursor: pointer; }
  button:disabled { opacity: .5; cursor: not-allowed; } [role="alert"] { color: #ffb4b4; }
  @media (max-width: 40rem) { main { padding: 1rem; } }
</style>
