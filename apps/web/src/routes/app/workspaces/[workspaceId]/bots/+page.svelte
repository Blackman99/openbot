<script lang="ts">
  import BotBindingStatus from '$lib/BotBindingStatus.svelte';
  import BotAvatar from '$lib/BotAvatar.svelte';
  import type { PageProps } from './$types';
  let { data, form }: PageProps = $props();
  const limits = [
    { name: 'maxTotalTokens', label: 'Total token limit', value: 32768, min: 1, max: 1000000 },
    { name: 'maxDurationSeconds', label: 'Duration limit (seconds)', value: 300, min: 1, max: 3600 },
    { name: 'maxTurns', label: 'Turn limit', value: 8, min: 1, max: 100 },
    { name: 'maxDelegationDepth', label: 'Delegation depth limit', value: 2, min: 0, max: 8 },
  ];
  let hasUsableModel = $derived(data.models.some((model) => model.available && model.enabled && model.basic));
</script>
<svelte:head><title>Bots · {data.workspace.name} · OpenBot</title></svelte:head>
<main>
  <a href={`/app/workspaces/${encodeURIComponent(data.workspace.id)}`}>Back to {data.workspace.name}</a>
  <h1>Bots</h1>
  <p><a href={`/app/workspaces/${data.workspace.id}/bots/deleted`}>Deleted Bots and recovery</a></p>
  <p>Create a persistent identity with instructions, a model and saved task defaults.</p>
  {#if data.bots.length === 0}<p>No Bots available yet.</p>{/if}
  <ul aria-label="Bots">
    {#each data.bots as bot (bot.id)}
      <li>
        <BotAvatar botId={bot.id} workspaceId={data.workspace.id} versionId={bot.avatarVersionId} name={bot.name} />
        <h2><a href={`/app/workspaces/${data.workspace.id}/bots/${bot.id}`}>{bot.name}</a></h2>
        <p>{bot.roleDescription}</p>
        {#if bot.lifecycleState === 'archived'}<p>Archived · New work blocked</p>{/if}
        <p>{bot.description || 'No description yet.'}</p>
        <p>{bot.accessRole ? `Your Bot role: ${bot.accessRole}` : 'Metadata only · No Bot access'}</p>
        <BotBindingStatus status={bot.bindingStatus} />
      </li>
    {/each}
  </ul>
  <section aria-labelledby="create-heading">
    <h2 id="create-heading">Create Bot</h2>
    <p>Private · Only you. You will be the Bot owner.</p>
    <form method="POST" action="?/create">
      <label for="bot-name">Bot name</label><input id="bot-name" name="name" required maxlength="100" value={form?.values.name ?? ''} />
      <label for="bot-role">Role description</label><input id="bot-role" name="roleDescription" required maxlength="200" value={form?.values.roleDescription ?? ''} />
      <p class="help">Describe this Bot's persona or purpose. This does not grant permissions.</p>
      <label for="bot-description">Description</label><textarea id="bot-description" name="description" maxlength="2000" rows="3" value={form?.values.description ?? ''}></textarea>
      <label for="bot-instructions">System instructions</label><textarea id="bot-instructions" name="instructions" required maxlength="32000" rows="8" value={form?.values.instructions ?? ''}></textarea>
      <label for="bot-model">Model</label>
      <select id="bot-model" name="modelChoice" required value={form?.values.modelChoice ?? ''}>
        <option value="" disabled>Select a model</option>
        {#each data.models as model (`${model.scope.kind}:${model.connectionId}`)}
          <option value={JSON.stringify({ scope: model.scope, connectionId: model.connectionId, modelId: model.modelId })} disabled={!model.available || !model.enabled || !model.basic}>
            {model.scope.kind === 'personal' ? 'Personal' : 'Workspace'} · {model.name} · {model.modelId} · {!model.available ? 'Unavailable' : !model.enabled ? 'Disabled' : !model.basic ? 'Basic capability unverified' : model.collaboration ? 'Collaboration-capable' : 'Chat-only'}
          </option>
        {/each}
      </select>
      {#if data.modelsUnavailable}<p role="status">Some model choices are unavailable. Reload after checking your model settings.</p>{/if}
      {#if !hasUsableModel}<p>Add or enable a model with verified text and streaming support before creating a Bot.</p>{/if}
      <p><a href="/app/settings/models">Personal models</a> · <a href={`/app/workspaces/${data.workspace.id}/models`}>Workspace models</a></p>
      {#if data.models.length > 0}
        <details><summary>Review model capabilities</summary><ul>
          {#each data.models as model (`${model.scope.kind}:${model.connectionId}`)}
            <li><a href={model.scope.kind === 'personal' ? `/app/settings/models/${model.connectionId}/capabilities` : `/app/workspaces/${data.workspace.id}/models/${model.connectionId}/capabilities`}>{model.name} capabilities</a></li>
          {/each}
        </ul></details>
      {/if}
      <fieldset><legend>Default task limits</legend>
        <p>These defaults are saved with this Bot. Task execution is not available yet.</p>
        {#each limits as limit (limit.name)}
          <label for={limit.name}>{limit.label}</label><input id={limit.name} name={limit.name} type="number" min={limit.min} max={limit.max} step="1" required value={form?.values[limit.name] || limit.value} />
        {/each}
        <p class="help">Total tokens include input and output. Set delegation depth to 0 to disable delegation.</p>
      </fieldset>
      {#if form?.error}<p role="alert">{form.error}</p>{/if}
      <button type="submit" disabled={!hasUsableModel}>Create Bot</button>
    </form>
  </section>
</main>
<style>
  :global(body) { margin: 0; background: #0d1117; color: #f0f6fc; font-family: Inter, ui-sans-serif, system-ui, sans-serif; }
  main { max-width: 55rem; margin: auto; padding: 2rem; }
  a { color: #a5d6ff; }
  ul { list-style: none; padding: 0; }
  li, section { border: 1px solid #30363d; border-radius: .75rem; margin-top: 1.5rem; padding: 1.5rem; overflow-wrap: anywhere; }
  h2 { margin-top: 0; }
  form, fieldset { display: grid; gap: .75rem; }
  fieldset { border: 1px solid #30363d; border-radius: .5rem; margin: 0; min-width: 0; padding: 1rem; }
  input, textarea, select, button { border: 1px solid #8b949e; border-radius: .4rem; padding: .75rem; color: inherit; background: #161b22; font: inherit; min-width: 0; width: auto; }
  button { cursor: pointer; justify-self: start; }
  button:disabled { cursor: not-allowed; opacity: .6; }
  .help { color: #a6b0bc; margin: 0; font-size: .9rem; }
  [role='alert'] { color: #ffb4ac; }
  @media (max-width: 40rem) { main { padding: 1rem; } }
</style>
