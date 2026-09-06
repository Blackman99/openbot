<script lang="ts">
  import type { PageProps } from './$types';
  let { data, form }: PageProps = $props();
  const base = $derived(`/app/workspaces/${data.workspace.id}/groups/${data.group.id}/routines`);
</script>
<svelte:head><title>Routines · {data.group.name} · OpenBot</title></svelte:head>
<main>
  <a href={`/app/workspaces/${data.workspace.id}/groups/${data.group.id}`}>Back to group</a>
  <h1>One-time routines</h1>
  <p>Schedule a bounded collaboration run for {data.group.name}. Bots cannot create or escalate routines.</p>
  {#if data.routines.length === 0}<p>No routines yet.</p>{/if}
  <ul aria-label="Routines">
    {#each data.routines as routine (routine.id)}
      <li>
        <h2><a href={`${base}/${routine.id}`}>{routine.prompt}</a></h2>
        <p>Status: {routine.status} · Zone: {routine.timeZone}</p>
        <p>Execute <time datetime={routine.executeAt}>{routine.executeAt}</time></p>
        <p>Expires <time datetime={routine.expiresAt}>{routine.expiresAt}</time></p>
        <p>Budget: {routine.maxCostMicros} µUSD</p>
      </li>
    {/each}
  </ul>
  <section aria-labelledby="create-heading">
    <h2 id="create-heading">Create routine</h2>
    <form method="POST" action="?/create">
      <label for="routine-prompt">Prompt</label>
      <textarea id="routine-prompt" name="prompt" required maxlength="32000" rows="4" value={form?.values?.prompt ?? ''}></textarea>
      <label for="routine-timezone">IANA time zone</label>
      <input id="routine-timezone" name="timeZone" required maxlength="100" value={form?.values?.timeZone ?? 'UTC'} />
      <label for="routine-execute">Execute at (ISO-8601)</label>
      <input id="routine-execute" name="executeAt" required value={form?.values?.executeAt ?? ''} placeholder="2026-09-07T01:00:00.000Z" />
      <label for="routine-expires">Expires at (ISO-8601)</label>
      <input id="routine-expires" name="expiresAt" required value={form?.values?.expiresAt ?? ''} placeholder="2026-09-08T01:00:00.000Z" />
      <label for="routine-budget">Max cost (micros)</label>
      <input id="routine-budget" name="maxCostMicros" type="number" min="1" required value={form?.values?.maxCostMicros ?? '1000000'} />
      <label for="routine-lead">Lead grant (optional)</label>
      <select id="routine-lead" name="leadGrantId" value={form?.values?.leadGrantId ?? ''}>
        <option value="">Group default routing</option>
        {#each data.grants as grant (grant.id)}
          <option value={grant.id}>{grant.name}</option>
        {/each}
      </select>
      {#if form?.error}<p role="alert">{form.error}</p>{/if}
      <button type="submit">Create routine</button>
    </form>
  </section>
</main>
<style>
  :global(body) { margin: 0; background: #0d1117; color: #f0f6fc; font-family: Inter, ui-sans-serif, system-ui, sans-serif; }
  main { max-width: 55rem; margin: auto; padding: 2rem; overflow-wrap: anywhere; }
  a { color: #a5d6ff; }
  ul { list-style: none; padding: 0; }
  li, section { border: 1px solid #30363d; border-radius: .75rem; margin-top: 1.5rem; padding: 1.5rem; }
  h2 { margin-top: 0; }
  form { display: grid; gap: .75rem; }
  input, textarea, select, button { border: 1px solid #8b949e; border-radius: .4rem; padding: .75rem; color: inherit; background: #161b22; font: inherit; min-width: 0; }
  button { cursor: pointer; justify-self: start; }
  [role='alert'] { color: #ffb4ac; }
</style>
