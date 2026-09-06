<script lang="ts">
  import type { PageProps } from './$types';
  let { data, form }: PageProps = $props();
  const routine = $derived(form && 'routine' in form && form.routine ? form.routine : data.routine);
  const mutable = $derived(routine.status === 'active' || routine.status === 'paused');
  const taskHref = $derived(
    routine.taskId && routine.conversationId
      ? `/app/workspaces/${data.workspace.id}/conversations/${routine.conversationId}/tasks/${routine.taskId}`
      : null,
  );
</script>
<svelte:head><title>Routine · {data.group.name} · OpenBot</title></svelte:head>
<main>
  <a href={`/app/workspaces/${data.workspace.id}/groups/${data.group.id}/routines`}>Back to routines</a>
  <h1>One-time routine</h1>
  <p>Group: {data.group.name}</p>
  <p>Status: {routine.status} · Routing: {routine.routingPolicy}</p>
  <p>Zone: {routine.timeZone}</p>
  <p>Execute <time datetime={routine.executeAt}>{routine.executeAt}</time></p>
  <p>Expires <time datetime={routine.expiresAt}>{routine.expiresAt}</time></p>
  <p>Budget: {routine.maxCostMicros} µUSD</p>
  <pre>{routine.prompt}</pre>
  {#if taskHref}
    <p><a href={taskHref}>Open linked collaboration task</a></p>
  {:else}
    <p>No collaboration task linked yet.</p>
  {/if}
  {#if form && 'message' in form && form.message}<p role="status">{form.message}</p>{/if}
  {#if form?.error}<p role="alert">{form.error}</p>{/if}
  {#if mutable}
    <section aria-labelledby="edit-heading">
      <h2 id="edit-heading">Edit routine</h2>
      <form method="POST" action="?/edit">
        <label for="edit-prompt">Prompt</label>
        <textarea id="edit-prompt" name="prompt" required maxlength="32000" rows="4">{form?.values?.prompt ?? routine.prompt}</textarea>
        <label for="edit-timezone">IANA time zone</label>
        <input id="edit-timezone" name="timeZone" required maxlength="100" value={form?.values?.timeZone ?? routine.timeZone} />
        <label for="edit-execute">Execute at (ISO-8601)</label>
        <input id="edit-execute" name="executeAt" required value={form?.values?.executeAt ?? routine.executeAt} />
        <label for="edit-expires">Expires at (ISO-8601)</label>
        <input id="edit-expires" name="expiresAt" required value={form?.values?.expiresAt ?? routine.expiresAt} />
        <label for="edit-budget">Max cost (micros)</label>
        <input id="edit-budget" name="maxCostMicros" type="number" min="1" required value={form?.values?.maxCostMicros ?? String(routine.maxCostMicros)} />
        <label for="edit-lead">Lead grant</label>
        <select id="edit-lead" name="leadGrantId" value={form?.values?.leadGrantId ?? routine.leadGrantId ?? ''}>
          <option value="">Group default routing</option>
          {#each data.grants as grant (grant.id)}
            <option value={grant.id}>{grant.name}</option>
          {/each}
        </select>
        <button type="submit">Save changes</button>
      </form>
    </section>
    <section aria-labelledby="lifecycle-heading">
      <h2 id="lifecycle-heading">Lifecycle</h2>
      {#if routine.status === 'active'}
        <form method="POST" action="?/pause"><button type="submit">Pause routine</button></form>
      {/if}
      {#if routine.status === 'paused'}
        <form method="POST" action="?/resume"><button type="submit">Resume routine</button></form>
      {/if}
      <form method="POST" action="?/cancel"><button class="danger" type="submit">Cancel routine</button></form>
    </section>
  {/if}
</main>
<style>
  :global(body) { margin: 0; background: #0d1117; color: #f0f6fc; font-family: Inter, ui-sans-serif, system-ui, sans-serif; }
  main { max-width: 55rem; margin: auto; padding: 2rem; overflow-wrap: anywhere; }
  a { color: #a5d6ff; }
  section { border: 1px solid #30363d; border-radius: .75rem; margin-top: 1.5rem; padding: 1.5rem; }
  h2 { margin-top: 0; }
  form { display: grid; gap: .75rem; margin-top: 1rem; }
  input, textarea, select, button { border: 1px solid #8b949e; border-radius: .4rem; padding: .75rem; color: inherit; background: #161b22; font: inherit; min-width: 0; }
  button { cursor: pointer; justify-self: start; }
  button.danger { border-color: #ffb4ac; color: #ffb4ac; }
  pre { white-space: pre-wrap; font: inherit; border: 1px solid #30363d; border-radius: .5rem; padding: 1rem; background: #161b22; }
  [role='alert'] { color: #ffb4ac; }
  [role='status'] { color: #7ee787; }
</style>
