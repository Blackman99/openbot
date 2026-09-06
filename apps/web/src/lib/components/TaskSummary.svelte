<script lang="ts">
  import type { TaskView } from '$lib/server/task-api.js';
  import TaskRunSummary from './TaskRunSummary.svelte';
  let { task, conversationBase, showLink = true }: { task: TaskView; conversationBase: string; showLink?: boolean } = $props();
  const routingReasons = { mention: 'Explicit @ mention', default: 'Group default', 'local-match': 'Local term match' };
  const labels = { queued: 'Queued', running: 'Running', completed: 'Completed', failed: 'Failed', cancelled: 'Cancelled', paused: 'Paused', waiting_budget: 'Waiting for budget', waiting_child: 'Waiting for child', waiting_input: 'Waiting for input', waiting_approval: 'Waiting for approval' };
</script>
<article id={`task-${task.id}`} aria-label={`Task for ${task.bot.name}`}>
  <h2>{task.bot.name} · {labels[task.status]}</h2>
  <p>Configuration version {task.bot.versionNumber} · Submitted by {task.executionUser.displayName}</p>
  <p>Created <time datetime={task.createdAt}>{task.createdAt}</time></p>
  {#if task.routing}<p>Selected by: {routingReasons[task.routing.reason]} · <a href={`${conversationBase}?routingTaskId=${task.id}#routing-${task.id}`}>Why this Bot?</a></p>{/if}
  <p>Current attempt {task.runCount} of {task.runCount}</p>
  {#if showLink}<a href={`${conversationBase}/tasks/${task.id}`}>Open task</a>{/if}
  {#if task.tokenBudgets?.length}
    <section aria-label="Token budget">
      <h3>Token budget</h3>
      {#each task.tokenBudgets as scope (scope.kind)}
        <p>{scope.kind === 'workspace' ? 'Workspace' : scope.kind === 'group' ? 'Group' : scope.kind === 'task' ? 'Task' : 'This run'}: used {scope.used.totalTokens} · reserved {scope.reserved.totalTokens} · remaining {[scope.remaining.inputTokens !== undefined ? `input ${scope.remaining.inputTokens}` : '', scope.remaining.outputTokens !== undefined ? `output ${scope.remaining.outputTokens}` : '', scope.remaining.totalTokens !== undefined ? `total ${scope.remaining.totalTokens}` : ''].filter(Boolean).join(', ')}</p>
      {/each}
    </section>
  {/if}
  {#if task.costBudgets?.length}
    <section aria-label="Cost budget">
      <h3>Cost budget</h3>
      {#each task.costBudgets as scope (scope.kind)}
        <p>{scope.kind === 'workspace' ? 'Workspace' : scope.kind === 'group' ? 'Group' : 'Task'}: used {scope.usedMicros} · reserved {scope.reservedMicros} · remaining {scope.remainingMicros}</p>
      {/each}
    </section>
  {/if}
  {#if task.olderRunsCursor}<p><a href={`${conversationBase}/tasks/${task.id}/runs?cursor=${encodeURIComponent(task.olderRunsCursor)}`}>View earlier attempts</a></p>{/if}
  {#each task.runs as run (run.id)}
    <TaskRunSummary {run} {conversationBase} />
  {/each}
</article>
<style>
  article { border: 1px solid #30363d; border-radius: .75rem; margin-top: 1.5rem; padding: 1.5rem; overflow-wrap: anywhere; }
  h2 { font-size: 1.25rem; }
  h3 { font-size: 1rem; }
  a { color: #a5d6ff; }
  @media (max-width: 40rem) { article { padding: 1rem; } }
</style>
