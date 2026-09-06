<script lang="ts">
  import RoutingDecision from '$lib/components/RoutingDecision.svelte';
  import { enhance } from '$app/forms';
  import type { SubmitFunction } from '@sveltejs/kit';
  import TaskCancellation from '$lib/components/TaskCancellation.svelte';
  import TaskPause from '$lib/components/TaskPause.svelte';
  import TaskResume from '$lib/components/TaskResume.svelte';
  import TaskHumanDecision from '$lib/components/TaskHumanDecision.svelte';
  import TaskSummary from '$lib/components/TaskSummary.svelte';
  import type { PageProps } from './$types';
  let { data, form }: PageProps = $props();
  let submitting = $state(false);
  let transportError = $state('');
  let unconfirmed = $state<Record<string, string> | null>(null);
  let retryForm = $derived(form && 'values' in form ? form : null);
  let cancellationForm = $derived(form && 'cancellation' in form ? form.cancellation : undefined);
  let pauseForm = $derived(form && 'pause' in form ? form.pause : undefined);
  let resumeForm = $derived(form && 'resume' in form ? form.resume : undefined);
  let decisionForm = $derived(form && 'decision' in form ? form.decision : undefined);
  let values = $derived(unconfirmed ?? retryForm?.values ?? {});
  let uncertain = $derived(Boolean(unconfirmed) || Boolean(retryForm?.uncertain));
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
  {#if data.task.status === 'cancelled' || data.task.status === 'paused' || data.partialOutput}
    <section aria-labelledby="partial-heading">
      <h2 id="partial-heading">Interrupted output</h2>
      {#if data.partialUnavailable}<p role="alert">Saved partial output is unavailable. Refresh this task to try again.</p>
      {:else if data.partialOutput?.partial}
        <p>{data.task.status === 'cancelled' ? 'This task was cancelled. The saved output is incomplete.' : data.task.status === 'paused' ? 'This task was paused. Resume starts a new attempt from the original task input. The saved output is incomplete.' : 'This task was interrupted. Recovery starts a new attempt from the original task input. The saved output is incomplete.'}</p>
        <p>Checkpoint: restart from the original task input.</p>
        <pre>{data.partialOutput.partial.text}</pre>
      {:else}<p>{data.task.status === 'cancelled' ? 'No output was saved before cancellation.' : data.task.status === 'paused' ? 'No output was saved before the pause.' : 'No output was saved before the interruption.'}</p>{/if}
    </section>
  {/if}
  <TaskCancellation canCancel={data.canCancel} canConfirm={data.canConfirmCancellation} idempotencyKey={data.idempotencyKey} expectedRunId={data.task.runs[0]!.id} actionUrl={`${base}/tasks/${data.task.id}?/cancel`} action={cancellationForm} />
  <TaskPause canPause={data.canPause} canConfirm={data.canConfirmPause} idempotencyKey={data.idempotencyKey} expectedRunId={data.task.runs[0]!.id} actionUrl={`${base}/tasks/${data.task.id}?/pause`} action={pauseForm} />
  <TaskResume canResume={data.canResume} canConfirm={data.canConfirmResume} idempotencyKey={data.idempotencyKey} expectedRunId={data.task.runs[0]!.id} actionUrl={`${base}/tasks/${data.task.id}?/resume`} action={resumeForm} />
  {#if data.task.humanRequest}
    <TaskHumanDecision canDecide={data.canDecide} request={data.task.humanRequest} idempotencyKey={data.idempotencyKey} actionUrl={`${base}/tasks/${data.task.id}?/decide`} action={decisionForm} />
  {/if}
  {#if transportError || retryForm?.error}<p role="alert">{transportError || retryForm?.error}</p>{/if}
  {#if data.canRetry || canConfirm}
    <section aria-labelledby="retry-heading">
      <h2 id="retry-heading">Retry this task</h2>
      <p>Retry uses this task's Bot configuration and respects current message edits and deletions. Earlier attempts stay available.</p>
      <form method="POST" action={`${base}/tasks/${data.task.id}?/retry`} use:enhance={retry}>
        <input type="hidden" name="idempotencyKey" value={values.idempotencyKey ?? data.idempotencyKey} />
        <input type="hidden" name="expectedRunId" value={values.expectedRunId ?? data.task.runs[0]?.id} />
        {#if uncertain}<p>The original retry request is preserved until its outcome is confirmed.</p>{/if}
        <button disabled={submitting || retryForm?.conflict}>{submitting ? 'Confirming…' : uncertain ? 'Confirm unchanged retry' : 'Retry failed task'}</button>
      </form>
    </section>
  {/if}
</main>
<style>
  :global(body) { margin: 0; background: #0d1117; color: #f0f6fc; font-family: Inter, ui-sans-serif, system-ui, sans-serif; }
  main { max-width: 55rem; margin: auto; padding: 2rem; overflow-wrap: anywhere; }
  a { color: #a5d6ff; } nav { display: flex; flex-wrap: wrap; gap: 1.5rem; margin: 1rem 0; }
  pre { white-space: pre-wrap; font: inherit; }
  section { margin-top: 1.5rem; } h2 { font-size: 1.25rem; }
  button { padding: .75rem; border: 1px solid #526171; border-radius: .4rem; font: inherit; background: #9ed0ff; color: #0d1117; cursor: pointer; }
  button:disabled { opacity: .5; cursor: not-allowed; } [role="alert"] { color: #ffb4b4; }
  @media (max-width: 40rem) { main { padding: 1rem; } }
</style>
