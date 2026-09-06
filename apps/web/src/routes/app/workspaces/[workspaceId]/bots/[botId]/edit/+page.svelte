<script lang="ts">
  import { enhance } from '$app/forms';
  import type { SubmitFunction } from '@sveltejs/kit';
  import type { BotModelChoice } from '$lib/server/bot-page.js';
  import type { PageProps } from './$types';
  let { data, form }: PageProps = $props();
  let transportError = $state('');
  let uncertain = $state(false);
  let modelChoice = $derived(form?.values.modelChoice ?? 'keep');
  const base = $derived(`/app/workspaces/${data.workspace.id}/bots/${data.bot.id}`);
  function choiceValue(model: BotModelChoice) {
    return JSON.stringify({ scope: model.scope, connectionId: model.connectionId, modelId: model.modelId });
  }
  const validChoice = $derived(modelChoice === 'keep' || data.models.some((model) => choiceValue(model) === modelChoice && model.enabled && model.basic && model.available));
  const knownChoice = $derived(modelChoice === 'keep' || data.models.some((model) => choiceValue(model) === modelChoice));
  const limits = [
    { name: 'maxTotalTokens', label: 'Total token limit', min: 1, max: 1000000 },
    { name: 'maxDurationSeconds', label: 'Duration limit (seconds)', min: 1, max: 3600 },
    { name: 'maxTurns', label: 'Turn limit', min: 1, max: 100 },
    { name: 'maxDelegationDepth', label: 'Delegation depth limit', min: 0, max: 8 },
  ] as const;
  const submit: SubmitFunction = () => async ({ result, update }) => {
    if (result.type === 'error') {
      transportError = 'We could not confirm this change. Reload to inspect the current version before submitting another change.';
      uncertain = true;
      return;
    }
    transportError = '';
    await update();
  };
</script>
<svelte:head><title>Edit {data.bot.name} · OpenBot</title></svelte:head>
<main>
  <a href={base}>Back to Bot</a>
  <h1>Edit configuration</h1>
  <p>Editing version {data.bot.currentVersion.number}. Each effective change creates a new immutable version.</p>
  <p><a href={`${base}/edit`} data-sveltekit-reload>Reload current version</a> · <a href={`${base}/versions`}>Version history</a></p>
  {#if form?.error || transportError}<p role="alert">{transportError || form?.error}</p>{/if}
  <form method="POST" action="?/edit" use:enhance={submit}>
    <input type="hidden" name="expectedCurrentVersionId" value={form?.values.expectedCurrentVersionId ?? data.bot.currentVersion.id} />
    <label for="bot-name">Bot name</label><input id="bot-name" name="name" maxlength="100" required value={form?.values.name ?? data.bot.currentVersion.configuration.name} />
    <label for="bot-role">Role description</label><input id="bot-role" name="roleDescription" maxlength="200" required value={form?.values.roleDescription ?? data.bot.currentVersion.configuration.roleDescription} />
    <label for="bot-description">Description</label><textarea id="bot-description" name="description" maxlength="2000" rows="3" value={form?.values.description ?? data.bot.currentVersion.configuration.description}></textarea>
    <label for="bot-instructions">System instructions</label><textarea id="bot-instructions" name="instructions" maxlength="32000" rows="8" required value={form?.values.instructions ?? data.bot.currentVersion.configuration.instructions}></textarea>
    <label for="bot-model">Model</label>
    <select id="bot-model" name="modelChoice" required bind:value={modelChoice}>
      <option value="keep">Keep current model</option>
      {#if !knownChoice}<option value={modelChoice} disabled>Previously selected model unavailable</option>{/if}
      {#each data.models as model (`${model.scope.kind}:${model.connectionId}`)}
        <option value={choiceValue(model)} disabled={!model.enabled || !model.basic || !model.available}>
          {model.scope.kind === 'personal' ? 'Personal' : 'Workspace'} · {model.name} · {model.modelId} · {!model.available ? 'Unavailable' : !model.enabled ? 'Disabled' : !model.basic ? 'Basic capability unverified' : model.collaboration ? 'Collaboration-capable' : 'Chat-only'}
        </option>
      {/each}
    </select>
    <p>Current binding: {data.bot.currentVersion.configuration.modelBinding.modelId}. Keep it to edit other fields even if that model is unavailable. Selecting a model checks your current access and its availability when saving.</p>
    {#if data.modelsUnavailable}<p role="status">Some model choices could not be loaded. You can keep the current model.</p>{/if}
    {#if !validChoice}<p role="status">Choose an available model or explicitly select Keep current model before saving.</p>{/if}
    <fieldset><legend>Default task limits</legend>
      {#each limits as limit (limit.name)}
        <label for={limit.name}>{limit.label}</label><input id={limit.name} name={limit.name} type="number" min={limit.min} max={limit.max} step="1" required value={form?.values[limit.name] ?? data.bot.currentVersion.configuration.limits[limit.name]} />
      {/each}
    </fieldset>
    <label for="rationale">Rationale (optional)</label><textarea id="rationale" name="rationale" maxlength="500" rows="2" value={form?.values.rationale ?? ''}></textarea>
    <button disabled={uncertain || form?.blocked || !validChoice}>Save configuration</button>
  </form>
  <p><a href={`${base}#avatar-heading`}>Change avatar</a> using the authorized upload or removal controls.</p>
</main>
<style>
  :global(body) { margin: 0; background: #0d1117; color: #f0f6fc; font-family: Inter, ui-sans-serif, system-ui, sans-serif; }
  main { max-width: 55rem; margin: auto; padding: 2rem; overflow-wrap: anywhere; }
  a { color: #a5d6ff; } form, fieldset { display: grid; gap: .75rem; } fieldset { padding: 1rem; margin: 0; border: 1px solid #526171; min-width: 0; }
  input, textarea, select, button { font: inherit; padding: .75rem; border: 1px solid #526171; border-radius: .4rem; background: #161b22; color: inherit; min-width: 0; }
  textarea { resize: vertical; } button { cursor: pointer; background: #9ed0ff; color: #0d1117; } button:disabled { opacity: .5; cursor: not-allowed; }
  [role='alert'] { color: #ffb4b4; } [role='status'] { color: #c3cad5; }
  @media (max-width: 40rem) { main { padding: 1rem; } }
</style>
