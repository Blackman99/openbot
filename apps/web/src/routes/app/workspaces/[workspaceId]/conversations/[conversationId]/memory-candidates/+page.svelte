<script lang="ts">
  import { enhance } from '$app/forms';
  import type { PageProps } from './$types';
  let { data, form }: PageProps = $props();
  const base = $derived(
    `/app/workspaces/${data.workspace.id}/conversations/${data.conversation.id}`,
  );
  const originGroupId = $derived(
    data.conversation.subject.kind === 'group' ? data.conversation.subject.id : '',
  );
  const previewFor = $derived(
    form?.action === 'previewCandidate' && form.preview ? form.preview : undefined,
  );
  const approveKey = crypto.randomUUID();
  const rejectKey = crypto.randomUUID();
  const confirmKey = crypto.randomUUID();
</script>
<svelte:head><title>Memory review inbox · OpenBot</title></svelte:head>
<main>
  <a href={base}>Back to conversation</a>
  <h1>Memory review inbox</h1>
  <p>Pending and rejected suggestions stay out of search and later answers until a reviewer approves an explicit destination.</p>
  {#if form?.error}<p role="alert">{form.error}</p>{/if}
  {#each data.candidatePage.candidates as candidate (candidate.id)}
    <article>
      <h2>{candidate.status}</h2>
      <p>{candidate.body}</p>
      <p>Proposed scope: {candidate.proposedScope.kind} · Sources: {candidate.sourceCount} · Confidence {candidate.confidence} (local rule)</p>
      {#if candidate.status === 'pending'}
        <form method="POST" action="?/editCandidate" use:enhance>
          <input type="hidden" name="candidateId" value={candidate.id} />
          <input type="hidden" name="expectedRevision" value={String(candidate.revision)} />
          <label for={`edit-${candidate.id}`}>Reviewed text</label>
          <textarea id={`edit-${candidate.id}`} name="body" maxlength="1000" required>{form?.values.candidateId === candidate.id && form.values.body ? form.values.body : candidate.body}</textarea>
          <button>Save edited candidate</button>
        </form>
        <form method="POST" action="?/rejectCandidate" use:enhance>
          <input type="hidden" name="candidateId" value={candidate.id} />
          <input type="hidden" name="expectedRevision" value={String(candidate.revision)} />
          <input type="hidden" name="idempotencyKey" value={form?.values.candidateId === candidate.id && form.values.idempotencyKey && form.action === 'rejectCandidate' ? form.values.idempotencyKey : rejectKey} />
          <button>Reject candidate</button>
        </form>
        {#if originGroupId}
          <form method="POST" action="?/approveCandidate" use:enhance>
            <input type="hidden" name="candidateId" value={candidate.id} />
            <input type="hidden" name="expectedRevision" value={String(candidate.revision)} />
            <input type="hidden" name="destination" value={`group:${originGroupId}`} />
            <input type="hidden" name="idempotencyKey" value={form?.values.candidateId === candidate.id && form.action === 'approveCandidate' && form.values.idempotencyKey ? form.values.idempotencyKey : approveKey} />
            <label for={`approve-confidence-${candidate.id}`}>Reviewer confidence</label>
            <input id={`approve-confidence-${candidate.id}`} type="number" name="confidence" min="0" max="1" step="any" required value={form?.values.candidateId === candidate.id && form.values.confidence ? form.values.confidence : '0.5'} />
            <button>Approve into this group</button>
          </form>
        {/if}
        <form method="POST" action="?/previewCandidate" use:enhance>
          <input type="hidden" name="candidateId" value={candidate.id} />
          <input type="hidden" name="expectedRevision" value={String(candidate.revision)} />
          <label for={`destination-${candidate.id}`}>Wider destination</label>
          <select id={`destination-${candidate.id}`} name="destination">
            {#each data.destinationGroups.filter((group) => group.id !== originGroupId) as group (group.id)}
              <option value={`group:${group.id}`}>{group.name}</option>
            {/each}
            {#each data.destinationBots as bot (bot.id)}
              <option value={`bot:${bot.id}`}>{bot.name}</option>
            {/each}
            {#if data.canApproveWorkspace}<option value={`workspace:${data.workspace.id}`}>This workspace</option>{/if}
          </select>
          <label for={`preview-confidence-${candidate.id}`}>Reviewer confidence</label>
          <input id={`preview-confidence-${candidate.id}`} type="number" name="confidence" min="0" max="1" step="any" required value={form?.values.candidateId === candidate.id && form.values.confidence ? form.values.confidence : '0.5'} />
          <button>Preview wider approval</button>
        </form>
        {#if previewFor && form?.values.candidateId === candidate.id}
          <section>
            <h3>Confirm wider audience</h3>
            <p>Reviewed content: {previewFor.content}</p>
            <p>Destination: {previewFor.destination.kind}</p>
            <p>Resulting visibility: {previewFor.visibility.summary}</p>
            <form method="POST" action="?/confirmCandidate" use:enhance>
              <input type="hidden" name="candidateId" value={candidate.id} />
              <input type="hidden" name="intentId" value={previewFor.id} />
              <input type="hidden" name="idempotencyKey" value={form.values.idempotencyKey && form.action === 'confirmCandidate' ? form.values.idempotencyKey : confirmKey} />
              <button>Confirm this approval</button>
            </form>
          </section>
        {/if}
      {/if}
    </article>
  {:else}
    <p>No extracted candidates in this conversation.</p>
  {/each}
</main>
<style>
  :global(body) { margin: 0; background: #0d1117; color: #f0f6fc; font-family: Inter, ui-sans-serif, system-ui, sans-serif; }
  main { max-width: 55rem; margin: auto; padding: 2rem; overflow-wrap: anywhere; } a { color: #a5d6ff; }
  article { border: 1px solid #30363d; border-radius: .6rem; padding: 1rem; margin: 1rem 0; }
  form { display: grid; gap: .75rem; margin: 1rem 0; } input, select, textarea, button { font: inherit; color: inherit; background: #161b22; border: 1px solid #8b949e; border-radius: .4rem; padding: .75rem; min-width: 0; }
  button { cursor: pointer; justify-self: start; } [role='alert'] { color: #ffb4ac; }
</style>
