<script lang="ts">
  import { enhance } from '$app/forms';
  import type { SubmitFunction } from '@sveltejs/kit';
  import BotAvatar from '$lib/BotAvatar.svelte';
  import BotBindingStatus from '$lib/BotBindingStatus.svelte';
  import type { BotModelChoice } from '$lib/server/bot-page.js';
  import type { PageProps } from './$types';
  let { data, form }: PageProps = $props();
  let uncertain = $state(false);
  let submitting = $state(false);
  let transportError = $state('');
  const base = $derived(`/app/workspaces/${data.workspace.id}/bots/${data.bot.id}`);
  const configuration = $derived(data.preview.configuration);
  let modelChoice = $derived(form?.values.modelChoice ?? (data.preview.bindingStatus.state === 'ready' ? 'keep' : ''));
  function choiceValue(model: BotModelChoice) { return JSON.stringify({ scope: model.scope, connectionId: model.connectionId, modelId: model.modelId }); }
  const validChoice = $derived((modelChoice === 'keep' && data.preview.bindingStatus.state === 'ready') || data.models.some((model) => choiceValue(model) === modelChoice && model.enabled && model.basic && model.available));
  const knownChoice = $derived(!modelChoice || modelChoice === 'keep' || data.models.some((model) => choiceValue(model) === modelChoice));
  const submit: SubmitFunction = () => {
    submitting = true;
    return async ({ result, update }) => {
      submitting = false;
      if (result.type === 'error') {
        transportError = 'We could not confirm this copy. Check your Bots for a newly created copy before submitting again.';
        uncertain = true;
        return;
      }
      transportError = '';
      await update();
    };
  };
</script>
<svelte:head><title>Copy {configuration.name} · OpenBot</title></svelte:head>
<main>
  <a href={base}>Back to Bot</a>
  <h1>Copy configuration</h1>
  <p>Review source version {data.preview.sourceVersionNumber}. Confirming creates a new private Bot with you as its only owner.</p>
  <p><a href={`${base}/copy`} data-sveltekit-reload>Reload preview</a> · <a href={`/app/workspaces/${data.workspace.id}/bots`}>Check your Bots</a></p>
  {#if form?.error || transportError}<p role="alert">{transportError || form?.error}</p>{/if}
  <section aria-labelledby="included"><h2 id="included">Included</h2>
    <ul><li>Identity: name, role description and description</li><li>System instructions</li><li>Execution limits</li><li>Authorized avatar reference</li><li>Current model binding or your selected replacement</li></ul>
    <h3>{configuration.name}</h3><p>{configuration.roleDescription}</p><p>{configuration.description || 'No description yet.'}</p>
    <BotAvatar botId={data.preview.sourceBotId} workspaceId={data.workspace.id} versionId={configuration.avatarObjectId ? data.preview.sourceVersionId : undefined} name={configuration.name} />
    <h3>System instructions</h3><pre>{configuration.instructions}</pre>
    <h3>Execution limits</h3><dl>
      <dt>Total tokens</dt><dd>{configuration.limits.maxTotalTokens}</dd>
      <dt>Duration (seconds)</dt><dd>{configuration.limits.maxDurationSeconds}</dd>
      <dt>Turns</dt><dd>{configuration.limits.maxTurns}</dd>
      <dt>Delegation depth</dt><dd>{configuration.limits.maxDelegationDepth}</dd>
    </dl>
    <h3>Source model</h3><p>{configuration.modelBinding.scope.kind === 'personal' ? 'Personal' : 'Workspace'} · {configuration.modelBinding.modelId}</p>
    <BotBindingStatus status={data.preview.bindingStatus} />
  </section>
  <section aria-labelledby="excluded"><h2 id="excluded">Excluded</h2><ul><li>Provider credentials and sensitive headers</li><li>Permissions and ACLs</li><li>Conversation and task history</li><li>Memory</li><li>File contents</li><li>Prior audits</li></ul></section>
  <form method="POST" action="?/confirm" use:enhance={submit}>
    <input type="hidden" name="expectedCurrentVersionId" value={form?.values.expectedCurrentVersionId ?? data.preview.sourceVersionId} />
    <label for="copy-model">Model for the copy</label>
    <select id="copy-model" name="modelChoice" required bind:value={modelChoice}>
      <option value="" disabled>Select an accessible model</option>
      <option value="keep" disabled={data.preview.bindingStatus.state !== 'ready'}>Keep source model</option>
      {#if !knownChoice}<option value={modelChoice} disabled>Previously selected model unavailable</option>{/if}
      {#each data.models as model (`${model.scope.kind}:${model.connectionId}`)}
        <option value={choiceValue(model)} disabled={!model.enabled || !model.basic || !model.available}>{model.scope.kind === 'personal' ? 'Personal' : 'Workspace'} · {model.name} · {model.modelId} · {!model.available ? 'Unavailable' : !model.enabled ? 'Disabled' : !model.basic ? 'Basic capability unverified' : model.collaboration ? 'Collaboration-capable' : 'Chat-only'}</option>
      {/each}
    </select>
    {#if data.preview.bindingStatus.state !== 'ready'}<p>A replacement is required because you cannot currently use the source model.</p>{/if}
    {#if data.modelsUnavailable}<p role="status">Some model choices could not be loaded. Reload to refresh available choices.</p>{/if}
    <p>Your current model access and the source version are checked again when you confirm.</p>
    <button disabled={submitting || uncertain || form?.blocked || !validChoice}>{submitting ? 'Creating copy…' : 'Confirm private copy'}</button>
    <a href={base}>Cancel</a>
  </form>
</main>
<style>
  :global(body) { margin: 0; background: #0d1117; color: #f0f6fc; font-family: Inter, ui-sans-serif, system-ui, sans-serif; }
  main { max-width: 55rem; margin: auto; padding: 2rem; overflow-wrap: anywhere; }
  a { color: #a5d6ff; } section { border: 1px solid #30363d; border-radius: .75rem; margin-top: 1.5rem; padding: 1.5rem; }
  pre { background: #161b22; padding: 1rem; white-space: pre-wrap; overflow-wrap: anywhere; font: inherit; }
  dl { display: grid; grid-template-columns: 1fr 1fr; gap: .75rem; } dd { margin: 0; }
  form { display: grid; gap: .75rem; margin-top: 1.5rem; }
  select, button { font: inherit; padding: .75rem; border: 1px solid #526171; border-radius: .4rem; background: #161b22; color: inherit; min-width: 0; }
  button { cursor: pointer; background: #9ed0ff; color: #0d1117; } button:disabled { opacity: .5; cursor: not-allowed; }
  [role='alert'] { color: #ffb4b4; }
  @media (max-width: 40rem) { main { padding: 1rem; } section { padding: 1rem; } }
</style>
