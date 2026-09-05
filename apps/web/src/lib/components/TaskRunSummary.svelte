<script lang="ts">
  import type { TaskRun, TaskErrorCode } from '$lib/server/task-api.js';
  let { run, conversationBase }: { run: TaskRun; conversationBase: string } = $props();
  const labels = { queued: 'Queued', running: 'Running', completed: 'Completed', failed: 'Failed', cancelled: 'Cancelled' };
  const errors: Record<TaskErrorCode, string> = {
    execution_forbidden: 'Access changed before this task could finish.',
    model_unavailable: 'The selected model is unavailable to the person who submitted this task.',
    provider_failed: 'The model request failed.',
    execution_timeout: 'The model request exceeded its time limit.',
    output_limit: 'The model response exceeded its size limit.',
    context_limit: 'The conversation exceeded the allowed context size.',
    worker_stopped: 'The worker stopped before this request finished.',
  };
</script>
<section aria-label={`Attempt ${run.attempt}`}>
  <h3>Attempt {run.attempt} · {labels[run.status]}</h3>
  <p>Created <time datetime={run.createdAt}>{run.createdAt}</time></p>
  {#if run.startedAt}<p>Started <time datetime={run.startedAt}>{run.startedAt}</time></p>{/if}
  {#if run.finishedAt}<p>Finished <time datetime={run.finishedAt}>{run.finishedAt}</time></p>{/if}
  {#if run.provider}<p>Model: {run.provider.modelId} · {run.provider.protocol}</p>{:else}<p>A model has not been called.</p>{/if}
  {#if run.usage}<p>Input tokens: {run.usage.inputTokens} · Output tokens: {run.usage.outputTokens}</p>{:else}<p>Token usage has not been reported.</p>{/if}
  {#if run.error}<p class="failure">{errors[run.error]}</p>{/if}
  {#if run.output}<a href={`${conversationBase}?messageId=${run.output.messageId}#message-${run.output.messageId}`}>Open conversation response</a>{/if}
</section>
<style>
  h3 { font-size: 1rem; }
  section { border-top: 1px solid #30363d; margin-top: 1rem; overflow-wrap: anywhere; }
  a { color: #a5d6ff; } .failure { color: #ffb4b4; }
</style>
