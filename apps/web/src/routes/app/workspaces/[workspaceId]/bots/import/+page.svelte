<script lang="ts">
  import { untrack } from 'svelte';
  import type { BotModelChoice } from '$lib/server/bot-page.js';
  import type { PageProps } from './$types';
  let { data, form }: PageProps = $props();
  const initial = untrack(() => ({
    template: form?.values.template ?? '',
    compareBotId: form?.values.compareBotId ?? '',
    modelChoice: form?.values.modelChoice ?? '',
  }));
  let template = $state(initial.template);
  let compareBotId = $state(initial.compareBotId);
  let modelChoice = $state(initial.modelChoice);
  function fieldErrors() {
    if (!form || !('fields' in form) || !Array.isArray(form.fields)) return [];
    return form.fields.flatMap((field) =>
      field &&
      typeof field === 'object' &&
      'field' in field &&
      'code' in field &&
      typeof field.field === 'string' &&
      typeof field.code === 'string'
        ? [{ field: field.field, code: field.code }]
        : [],
    );
  }
  function choiceValue(model: BotModelChoice) {
    return JSON.stringify({
      scope: model.scope,
      connectionId: model.connectionId,
      modelId: model.modelId,
    });
  }
  function modelSatisfies(model: BotModelChoice, required: string) {
    if (!model.enabled || !model.available || !model.basic) return false;
    if (required === 'collaboration') return model.collaboration;
    if (required === 'visionInput') return model.visionInput;
    return true;
  }
  const preview = $derived(form && 'preview' in form ? form.preview : undefined);
  const validModel = $derived(
    data.models.some(
      (model) =>
        choiceValue(model) === modelChoice &&
        modelSatisfies(model, preview?.template.capabilities.required ?? 'basic'),
    ),
  );
  const canCreate = $derived(Boolean(preview && validModel));
</script>
<svelte:head><title>Import Bot template · OpenBot</title></svelte:head>
<main>
  <a href={`/app/workspaces/${data.workspace.id}/bots`}>Back to Bots</a>
  <h1>Import Bot template</h1>
  <p>Review the complete instructions, capabilities, permissions and budgets before creating an independent Bot. Creation stays disabled until you bind a compatible model.</p>
  {#if form?.error}<p role="alert">{form.error}</p>{/if}
  {#if fieldErrors().length}
    <ul aria-label="Template field errors">
      {#each fieldErrors() as field (`${field.field}:${field.code}`)}
        <li>{field.field || 'template'} · {field.code}</li>
      {/each}
    </ul>
  {/if}
  <form method="POST">
    <label for="template-json">Template JSON</label>
    <textarea id="template-json" name="template" required bind:value={template} rows="16"></textarea>
    <label for="compare-bot">Compare with a local Bot</label>
    <select id="compare-bot" name="compareBotId" bind:value={compareBotId}>
      <option value="">No comparison</option>
      {#each data.bots as bot (bot.id)}
        <option value={bot.id}>{bot.name}</option>
      {/each}
    </select>
    <button type="submit" name="intent" value="preview">Preview template</button>
  </form>
  {#if preview}
    <section aria-labelledby="review-heading">
      <h2 id="review-heading">{preview.template.identity.name}</h2>
      <p>{preview.template.identity.roleDescription}</p>
      <p>{preview.template.identity.description || 'No description yet.'}</p>
      <h3>System instructions</h3>
      <pre>{preview.template.instructions}</pre>
      <h3>Requested capabilities</h3>
      <p>{preview.template.capabilities.required}</p>
      <h3>Permissions</h3>
      <p>Declared collaboration visibility: {preview.template.collaboration.visibility}. Import creates a new private Bot you own. Source ACLs, history and memory are not imported.</p>
      <h3>Budgets</h3>
      <dl>
        <dt>Total tokens</dt><dd>{preview.template.budgets.maxTotalTokens}</dd>
        <dt>Duration (seconds)</dt><dd>{preview.template.budgets.maxDurationSeconds}</dd>
        <dt>Turns</dt><dd>{preview.template.budgets.maxTurns}</dd>
        <dt>Delegation depth</dt><dd>{preview.template.budgets.maxDelegationDepth}</dd>
      </dl>
      {#if preview.differences.length}
        <h3>Differences from the selected local Bot</h3>
        <ul>
          {#each preview.differences as difference (difference.field)}
            <li>{difference.field}: template {String(difference.template)} · local {String(difference.local)}</li>
          {/each}
        </ul>
      {/if}
    </section>
    <form method="POST">
      <input type="hidden" name="template" value={template} />
      <input type="hidden" name="compareBotId" value={compareBotId} />
      <label for="import-model">Model for the imported Bot</label>
      <select id="import-model" name="modelChoice" required bind:value={modelChoice}>
        <option value="" disabled>Select an accessible model</option>
        {#each data.models as model (`${model.scope.kind}:${model.connectionId}`)}
          <option value={choiceValue(model)} disabled={!modelSatisfies(model, preview.template.capabilities.required)}>{model.scope.kind === 'personal' ? 'Personal' : 'Workspace'} · {model.name} · {model.modelId}</option>
        {/each}
      </select>
      <button name="intent" value="create" disabled={!canCreate}>Create independent Bot</button>
    </form>
  {/if}
</main>
<style>
  :global(body) { margin: 0; background: #0d1117; color: #f0f6fc; font-family: Inter, ui-sans-serif, system-ui, sans-serif; }
  main { max-width: 55rem; margin: auto; padding: 2rem; overflow-wrap: anywhere; }
  a { color: #a5d6ff; } section { border: 1px solid #30363d; border-radius: .75rem; margin-top: 1.5rem; padding: 1.5rem; }
  pre, textarea { background: #161b22; padding: 1rem; white-space: pre-wrap; overflow-wrap: anywhere; font: inherit; width: 100%; box-sizing: border-box; color: inherit; }
  dl { display: grid; grid-template-columns: 1fr 1fr; gap: .75rem; } dd { margin: 0; }
  form { display: grid; gap: .75rem; margin-top: 1.5rem; }
  select, button, textarea { font: inherit; padding: .75rem; border: 1px solid #526171; border-radius: .4rem; background: #161b22; color: inherit; min-width: 0; }
  button { cursor: pointer; background: #9ed0ff; color: #0d1117; } button:disabled { opacity: .5; cursor: not-allowed; }
  [role='alert'] { color: #ffb4b4; }
</style>
