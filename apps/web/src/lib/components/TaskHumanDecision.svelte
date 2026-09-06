<script lang="ts">
  import { enhance } from '$app/forms';
  import type { SubmitFunction } from '@sveltejs/kit';
  import type { TaskHumanRequest } from '$lib/server/task-contract.js';
  let {
    canDecide,
    request,
    idempotencyKey,
    actionUrl,
    action,
  }: {
    canDecide: boolean;
    request: TaskHumanRequest;
    idempotencyKey: string;
    actionUrl: string;
    action?: { error?: string; conflict?: boolean };
  } = $props();
  let submitting = $state(false);
  let transportError = $state('');
  const decide: SubmitFunction = ({ cancel }) => {
    if (submitting) {
      cancel();
      return;
    }
    submitting = true;
    transportError = '';
    return async ({ result, update }) => {
      try {
        if (result.type === 'error') {
          transportError = 'The decision could not be confirmed. Refresh the task and try again.';
          return;
        }
        await update({ reset: false, invalidateAll: false });
      } catch {
        transportError = 'The decision could not be confirmed. Refresh the task and try again.';
      } finally {
        submitting = false;
      }
    };
  };
</script>
{#if canDecide}
  <section aria-labelledby="human-decision-heading">
    <h2 id="human-decision-heading">{request.kind === 'input' ? 'Submit requested input' : 'Approve or reject'}</h2>
    {#if transportError || action?.error}<p role="alert">{transportError || action?.error}</p>{/if}
    {#if request.kind === 'input'}
      <form method="POST" action={actionUrl} use:enhance={decide}>
        <input type="hidden" name="idempotencyKey" value={idempotencyKey} />
        {#each Object.entries(request.responseSchema?.properties ?? {}) as [name, field] (name)}
          <label>
            {name}
            {#if field.type === 'boolean'}
              <select name={name} required={request.responseSchema?.required.includes(name)}>
                <option value="">Select</option>
                <option value="true">Yes</option>
                <option value="false">No</option>
              </select>
            {:else if field.type === 'number'}
              <input name={name} type="number" step="any" required={request.responseSchema?.required.includes(name)} />
            {:else}
              <input name={name} type="text" required={request.responseSchema?.required.includes(name)} maxlength="8000" />
            {/if}
          </label>
        {/each}
        <button disabled={submitting || action?.conflict}>{submitting ? 'Confirming…' : 'Submit input'}</button>
      </form>
    {:else}
      <form method="POST" action={actionUrl} use:enhance={decide}>
        <input type="hidden" name="idempotencyKey" value={idempotencyKey} />
        <button name="decision" value="approve" disabled={submitting || action?.conflict}>{submitting ? 'Confirming…' : 'Approve'}</button>
        <button name="decision" value="reject" disabled={submitting || action?.conflict}>{submitting ? 'Confirming…' : 'Reject'}</button>
      </form>
    {/if}
  </section>
{/if}
<style>
  section { margin-top: 1.5rem; }
  h2 { font-size: 1.25rem; }
  label { display: block; margin: .75rem 0; }
  input, select, button { font: inherit; }
  button { padding: .75rem; border: 1px solid #526171; border-radius: .4rem; background: #9ed0ff; color: #0d1117; cursor: pointer; margin-right: .75rem; }
  button:disabled { opacity: .5; cursor: not-allowed; }
  [role="alert"] { color: #ffb4b4; }
</style>
