<script lang="ts">
  import { untrack } from 'svelte';
  import type { BotModelChoice } from '$lib/server/bot-page.js';
  import type { PageProps } from './$types';
  let { data, form }: PageProps = $props();
  const initial = untrack(() => ({
    template: form?.values.template ?? '',
    acknowledgements: form?.values.acknowledgements ?? [],
    modelBindings: form?.values.modelBindings ?? {},
  }));
  let template = $state(initial.template);
  let acknowledgements = $state<string[]>(initial.acknowledgements);
  let modelBindings = $state<Record<string, string>>(initial.modelBindings);
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
  const requiredAcks = $derived(preview?.acknowledgements.map((row) => row.id) ?? []);
  const mappingsReady = $derived(
    Boolean(
      preview &&
        preview.mappings.every((mapping) => {
          const selected = data.models.find((model) => choiceValue(model) === modelBindings[mapping.botKey]);
          return selected && modelSatisfies(selected, mapping.requiredCapability);
        }),
    ),
  );
  const acksReady = $derived(requiredAcks.every((id) => acknowledgements.includes(id)));
  const canCreate = $derived(Boolean(preview && mappingsReady && acksReady));
  function toggleAck(id: string, checked: boolean) {
    acknowledgements = checked
      ? [...new Set([...acknowledgements, id])]
      : acknowledgements.filter((item) => item !== id);
  }
  function objectLabel(row: { kind: string; name?: unknown; key?: unknown; botKey?: unknown }) {
    if (row.kind === 'group') return `Group · ${String(row.name ?? '')}`;
    if (row.kind === 'bot') return `Bot · ${String(row.name ?? row.key ?? '')}`;
    if (row.kind === 'membership') return `Membership · ${String(row.botKey ?? '')}`;
    if (row.kind === 'routine') return `Routine · ${String(row.name ?? row.key ?? '')} · disabled`;
    if (row.kind === 'defaultLead') return `Default Lead · ${String(row.botKey ?? 'none')}`;
    if (row.kind === 'collaboration') return 'Collaboration limit';
    if (row.kind === 'budgets') return 'Default budgets';
    return row.kind;
  }
</script>
<svelte:head><title>Import team template · OpenBot</title></svelte:head>
<main>
  <a href={`/app/workspaces/${data.workspace.id}/groups`}>Back to groups</a>
  <h1>Import team template</h1>
  <p>Review every object that will be created. Import stays disabled until each Bot has a compatible model mapping and every required acknowledgement is accepted.</p>
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
    <button type="submit" name="intent" value="preview">Preview template</button>
  </form>
  {#if preview}
    <section aria-labelledby="objects-heading">
      <h2 id="objects-heading">Objects to create</h2>
      <ul aria-label="Objects to create">
        {#each preview.objects as row, index (`${row.kind}:${index}`)}
          <li>{objectLabel(row)}</li>
        {/each}
      </ul>
    </section>
    <form method="POST">
      <input type="hidden" name="template" value={template} />
      {#each preview.mappings as mapping (mapping.botKey)}
        <label for={`model-${mapping.botKey}`}>Model for {mapping.botKey}</label>
        <select
          id={`model-${mapping.botKey}`}
          name={`modelBinding.${mapping.botKey}`}
          required
          bind:value={modelBindings[mapping.botKey]}
        >
          <option value="" disabled>Select an accessible model</option>
          {#each data.models as model (`${mapping.botKey}:${model.scope.kind}:${model.connectionId}`)}
            <option value={choiceValue(model)} disabled={!modelSatisfies(model, mapping.requiredCapability)}>
              {model.scope.kind === 'personal' ? 'Personal' : 'Workspace'} · {model.name} · {model.modelId}
            </option>
          {/each}
        </select>
      {/each}
      <fieldset>
        <legend>Required acknowledgements</legend>
        {#each preview.acknowledgements as acknowledgement (acknowledgement.id)}
          <label>
            <input
              type="checkbox"
              name={`ack.${acknowledgement.id}`}
              checked={acknowledgements.includes(acknowledgement.id)}
              onchange={(event) => toggleAck(acknowledgement.id, event.currentTarget.checked)}
            />
            {acknowledgement.id}
          </label>
        {/each}
      </fieldset>
      <button name="intent" value="create" disabled={!canCreate}>Create team</button>
    </form>
  {/if}
</main>
<style>
  :global(body) { margin: 0; background: #0d1117; color: #f0f6fc; font-family: Inter, ui-sans-serif, system-ui, sans-serif; }
  main { max-width: 55rem; margin: auto; padding: 2rem; overflow-wrap: anywhere; }
  a { color: #a5d6ff; } section { border: 1px solid #30363d; border-radius: .75rem; margin-top: 1.5rem; padding: 1.5rem; }
  textarea { background: #161b22; padding: 1rem; white-space: pre-wrap; overflow-wrap: anywhere; font: inherit; width: 100%; box-sizing: border-box; color: inherit; }
  form { display: grid; gap: .75rem; margin-top: 1.5rem; }
  select, button, textarea, input { font: inherit; padding: .75rem; border: 1px solid #526171; border-radius: .4rem; background: #161b22; color: inherit; min-width: 0; }
  button { cursor: pointer; background: #9ed0ff; color: #0d1117; } button:disabled { opacity: .5; cursor: not-allowed; }
  [role='alert'] { color: #ffb4b4; }
</style>
