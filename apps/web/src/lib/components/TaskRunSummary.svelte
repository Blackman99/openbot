<script lang="ts">
  import type { TaskRun, TaskErrorCode, ContinuationReason } from '$lib/server/task-api.js';
  let { run, conversationBase }: { run: TaskRun; conversationBase: string } = $props();
  const labels = { queued: 'Queued', running: 'Running', completed: 'Completed', failed: 'Failed', cancelled: 'Cancelled', paused: 'Paused' };
  const errors: Record<TaskErrorCode, string> = {
    execution_forbidden: 'Access changed before this task could finish.',
    model_unavailable: 'The selected model is unavailable to the person who submitted this task.',
    provider_failed: 'The model request failed.',
    execution_timeout: 'The model request exceeded its time limit.',
    output_limit: 'The model response exceeded its size limit.',
    context_limit: 'The conversation exceeded the allowed context size.',
    worker_stopped: 'The worker stopped before this request finished.',
  };
  const reasons: Record<ContinuationReason, string> = {
    provider_rate_limited: 'the previous model was rate limited',
    provider_unavailable: 'the previous model was temporarily unavailable',
    provider_connection_reset: 'the previous model connection reset',
  };
  const modelLabel = (model: { protocol: string; modelId: string }) =>
    `${model.modelId} · ${model.protocol}`;
</script>
<section aria-label={`Attempt ${run.attempt}`}>
  <h3>Attempt {run.attempt} · {labels[run.status]}</h3>
  <p>Created <time datetime={run.createdAt}>{run.createdAt}</time></p>
  {#if run.startedAt}<p>Started <time datetime={run.startedAt}>{run.startedAt}</time></p>{/if}
  {#if run.finishedAt}<p>Finished <time datetime={run.finishedAt}>{run.finishedAt}</time></p>{/if}
  {#if run.provider}<p>Model: {run.provider.modelId} · {run.provider.protocol}</p>{:else}<p>A model has not been called.</p>{/if}
  {#if run.continuation}
    <p>
      {#if run.continuation.origin === 'model_fallback'}
        {run.continuation.admitted ? 'Switched models' : 'Waiting to switch models'}
      {:else}
        {run.continuation.admitted ? 'Retried the same model' : 'Waiting to retry the same model'}
      {/if}
      from {modelLabel(run.continuation.previousProvider)} to {modelLabel(run.continuation.nextProvider)}
      because {reasons[run.continuation.reason]}.
    </p>
    {#if !run.continuation.admitted}
      <p>Planned model: {modelLabel(run.continuation.nextProvider)}</p>
      <p>Due <time datetime={run.continuation.dueAt}>{run.continuation.dueAt}</time></p>
    {/if}
  {/if}
  {#if run.usage}<p>Input tokens: {run.usage.inputTokens} · Output tokens: {run.usage.outputTokens}</p>{:else}<p>Token usage has not been reported.</p>{/if}
  {#if run.error}<p class="failure">{errors[run.error]}</p>{/if}
  {#if run.output}<a href={`${conversationBase}?messageId=${run.output.messageId}#message-${run.output.messageId}`}>Open conversation response</a>{/if}
</section>
<style>
  h3 { font-size: 1rem; }
  section { border-top: 1px solid #30363d; margin-top: 1rem; overflow-wrap: anywhere; }
  a { color: #a5d6ff; } .failure { color: #ffb4b4; }
</style>
