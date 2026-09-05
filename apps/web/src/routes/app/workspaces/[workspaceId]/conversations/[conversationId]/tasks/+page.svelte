<script lang="ts">
  import { enhance } from '$app/forms';
  import type { SubmitFunction } from '@sveltejs/kit';
  import TaskSummary from '$lib/components/TaskSummary.svelte';
  import type { PageProps } from './$types';
  let { data, form }: PageProps = $props();
  let submitting = $state(false);
  let transportError = $state('');
  let unconfirmed = $state<Record<string, string> | null>(null);
  let values = $derived(unconfirmed ?? form?.values ?? {});
  let prompt = $derived(values.body ?? '');
  let grantId = $derived(values.groupGrantId ?? '');
  let uncertain = $derived(Boolean(unconfirmed) || Boolean(form?.uncertain));
  let locked = $derived(uncertain || submitting || Boolean(form?.conflict));
  let base = $derived(`/app/workspaces/${data.workspace.id}/conversations/${data.conversation.id}`);
  const submit: SubmitFunction = ({ formData, cancel }) => {
    if (submitting) { cancel(); return; }
    const captured: Record<string, string> = {};
    for (const key of ['idempotencyKey', 'body', 'groupGrantId']) {
      const value = formData.get(key);
      if (typeof value === 'string') captured[key] = value;
    }
    submitting = true;
    transportError = '';
    return async ({ result, update }) => {
      try {
        if (result.type === 'error') {
          unconfirmed = captured;
          transportError = 'The task could not be confirmed. Retry this unchanged request to check the original submission.';
          return;
        }
        unconfirmed = null;
        await update({ reset: false, invalidateAll: false });
      } finally { submitting = false; }
    };
  };
</script>
<svelte:head><title>Tasks · OpenBot</title></svelte:head>
<main>
  <a href={base}>Back to conversation</a>
  <h1>Tasks</h1>
  <p>Submit a prompt to one Bot and return here to see its saved result.</p>
  <nav aria-label="Task pages">
    <a href={`${base}/tasks?limit=${data.limit}`} data-sveltekit-reload>Refresh tasks</a>
    {#if data.nextCursor}<a href={`${base}/tasks?cursor=${encodeURIComponent(data.nextCursor)}&limit=${data.limit}`}>Next tasks</a>{/if}
  </nav>
  {#if transportError || form?.error}<p role="alert">{transportError || form?.error}</p>{/if}
  {#if data.canSubmit}
    <section class="compose" aria-labelledby="run-heading">
      <h2 id="run-heading">Run a task</h2>
      <form method="POST" action={`${base}/tasks`} use:enhance={submit}>
        <input type="hidden" name="idempotencyKey" value={values.idempotencyKey ?? data.idempotencyKey} />
        {#if data.conversation.subject.kind === 'group'}
          <label for="task-bot">Mention a Bot (optional)</label>
          <select id="task-bot" name={locked ? undefined : 'groupGrantId'} bind:value={grantId} disabled={locked}>
            <option value="">Automatic · default or local match</option>
            {#each data.grants as grant (grant.id)}<option value={grant.id}>@ {grant.name}</option>{/each}
          </select>
          {#if locked}<input type="hidden" name="groupGrantId" value={grantId} />{/if}
          <p>A mention chooses that exact Bot. Automatic routing uses an eligible group default, then local persona matches.</p>
        {/if}
        <label for="task-prompt">Prompt</label>
        <textarea id="task-prompt" name="body" bind:value={prompt} rows="5" maxlength="32000" required readonly={locked}></textarea>
        {#if uncertain}<p>Your prompt and Bot choice are preserved for the same submission.</p>{/if}
        <button disabled={submitting || form?.conflict}>{submitting ? 'Submitting…' : uncertain ? 'Retry unchanged request' : 'Run task'}</button>
      </form>
    </section>
  {:else}<p>{data.canWrite ? 'Invite an active Bot to this group before running a task.' : 'This conversation is read-only. Its saved tasks remain available.'}</p>{/if}
  {#each data.tasks as task (task.id)}<TaskSummary {task} conversationBase={base} />{:else}<p>No tasks on this page.</p>{/each}
</main>
<style>
  :global(body) { margin: 0; background: #0d1117; color: #f0f6fc; font-family: Inter, ui-sans-serif, system-ui, sans-serif; }
  main { max-width: 55rem; margin: auto; padding: 2rem; overflow-wrap: anywhere; }
  a { color: #a5d6ff; } nav { display: flex; flex-wrap: wrap; gap: 1.5rem; margin: 1rem 0; }
  .compose { border: 1px solid #30363d; border-radius: .75rem; margin-top: 1.5rem; padding: 1.5rem; }
  form { display: grid; gap: .75rem; } textarea, select, button { padding: .75rem; border: 1px solid #526171; border-radius: .4rem; font: inherit; }
  textarea, select { background: #161b22; color: #f0f6fc; } textarea { resize: vertical; }
  button { background: #9ed0ff; color: #0d1117; cursor: pointer; } button:disabled { opacity: .5; cursor: not-allowed; }
  [role="alert"] { color: #ffb4b4; }
  @media (max-width: 40rem) { main { padding: 1rem; } .compose { padding: 1rem; } }
</style>
