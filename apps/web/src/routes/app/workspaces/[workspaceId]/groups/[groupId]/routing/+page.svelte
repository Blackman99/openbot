<script lang="ts">
  import type { PageProps } from './$types';
  let { data, form }: PageProps = $props();
  const groupBase = $derived(`/app/workspaces/${data.workspace.id}/groups/${data.group.id}`);
  const selection = $derived(form?.values.defaultGrantId ?? data.routing.defaultLead?.grantId ?? '');
  const revision = $derived(form?.values.expectedRevision ?? String(data.routing.revision));
  const blocked = $derived(Boolean(form?.conflict || form?.uncertain || data.routing.revision >= 2147483647));
  const missingSelection = $derived(Boolean(selection && !data.candidates.some(candidate => candidate.grantId === selection)));
</script>
<svelte:head><title>Group routing · {data.group.name} · OpenBot</title></svelte:head>
<main>
  <nav aria-label="Group navigation"><a href={groupBase}>{data.group.name}</a> · <a href={`${groupBase}/bots`}>Group Bots</a></nav>
  <h1>Group routing</h1>
  <p>A mentioned Bot leads the task. Otherwise, the group default is used when eligible, followed by local matching against public Bot personas.</p>
  {#if form?.error}<p role="alert">{form.error}</p>{/if}
  <section aria-labelledby="default-lead">
    <h2 id="default-lead">Default Lead</h2>
    {#if data.routing.defaultLead}
      <h3>{data.routing.defaultLead.bot.name}</h3>
      <p>{data.routing.defaultLead.bot.roleDescription}</p>
      <p>Saved membership: <code>{data.routing.defaultLead.grantId}</code></p>
      {#if data.routing.defaultLead.closed}
        <p class="notice">Membership closed. Automatic routing will use another eligible Bot. A new invitation does not replace this saved membership.</p>
      {:else}
        <p>The exact saved membership is checked when each new task is submitted.</p>
      {/if}
    {:else}
      <p>No default Lead. Automatic routing uses local persona matching.</p>
    {/if}
    {#if data.routing.canManage}
      <form method="POST" action="?/update">
        <input type="hidden" name="expectedRevision" value={revision} />
        <label for="default-grant">Default Bot</label>
        <select id="default-grant" name="defaultGrantId" disabled={blocked}>
          <option value="" selected={selection === ''}>No default · use local matching</option>
          {#if missingSelection}<option value={selection} disabled selected>Saved choice is unavailable · choose another Bot or clear</option>{/if}
          {#each data.candidates as candidate (candidate.grantId)}
            <option value={candidate.grantId} selected={selection === candidate.grantId}>{candidate.name} · {candidate.roleDescription}</option>
          {/each}
        </select>
        <p class="hint">Setting a default checks your current model access. Existing tasks keep their saved routing decisions.</p>
        <button disabled={blocked}>Save default</button>
      </form>
      {#if data.routing.defaultLead}
        <form method="POST" action="?/update">
          <input type="hidden" name="expectedRevision" value={revision} />
          <input type="hidden" name="defaultGrantId" value="" />
          <button disabled={blocked}>Clear default</button>
        </form>
      {/if}
    {:else}
      <p>Group owners and admins can change the default Lead.</p>
    {/if}
    <p><a href={`${groupBase}/routing`} data-sveltekit-reload>Refresh settings</a></p>
  </section>
</main>
<style>
  :global(body) { margin: 0; background: #0d1117; color: #f0f6fc; font-family: Inter, ui-sans-serif, system-ui, sans-serif; }
  main { max-width: 48rem; margin: auto; padding: 2rem; overflow-wrap: anywhere; }
  a { color: #a5d6ff; }
  section { border: 1px solid #30363d; border-radius: .75rem; padding: 1.5rem; margin-top: 1.5rem; background: #161b22; }
  form { display: grid; gap: .75rem; margin-top: 1.25rem; }
  select, button { box-sizing: border-box; width: 100%; padding: .75rem; border-radius: .4rem; border: 1px solid #526171; font: inherit; }
  select { color: #f0f6fc; background: #0d1117; }
  button { background: #9ed0ff; color: #0d1117; cursor: pointer; }
  :disabled { opacity: .6; cursor: default; }
  .hint { color: #b4c2d3; margin: 0; }
  [role="alert"], .notice { color: #ffcf8a; }
  @media (max-width: 40rem) { main { padding: 1rem; } section { padding: 1rem; } }
</style>
