<script lang="ts">
  import { enhance } from '$app/forms';
  import type { SubmitFunction } from '@sveltejs/kit';
  import BotAvatar from '$lib/BotAvatar.svelte';
  import type { PageProps } from './$types';
  let { data, form }: PageProps = $props();
  let transportError = $state('');
  let uncertain = $state(false);
  const base = $derived(`/app/workspaces/${data.workspace.id}/bots/${data.bot.id}`);
  const comparison = $derived(new URLSearchParams({ fromVersionId: data.version.id, toVersionId: data.bot.currentVersion.id }));
  const submit: SubmitFunction = () => async ({ result, update }) => {
    if (result.type === 'error') {
      transportError = 'We could not confirm this restoration. Reload to inspect the current version before submitting another change.';
      uncertain = true;
      return;
    }
    transportError = '';
    await update();
  };
</script>
<svelte:head><title>Version {data.version.number} · {data.bot.name} · OpenBot</title></svelte:head>
<main>
  <a href={`${base}/versions`}>Back to version history</a>
  <h1>Version {data.version.number}</h1>
  <p>{data.version.author.displayName} · <time datetime={data.version.createdAt}>{data.version.createdAt}</time></p>
  <p>{data.version.rationale}</p>
  <p><a href={`${base}/versions/compare?${comparison}`}>Compare with current version</a> · <a href={base}>Current Bot</a></p>
  <section aria-labelledby="configuration-heading">
    <h2 id="configuration-heading">Saved configuration</h2>
    <BotAvatar botId={data.bot.id} workspaceId={data.workspace.id} versionId={data.version.configuration.avatarObjectId ? data.version.id : undefined} name={data.version.configuration.name} />
    <h3>Bot name</h3><p>{data.version.configuration.name}</p>
    <h3>Role description</h3><p>{data.version.configuration.roleDescription}</p>
    <h3>Description</h3><p>{data.version.configuration.description || 'No description.'}</p>
    <h3>System instructions</h3><pre>{data.version.configuration.instructions}</pre>
    <h3>Model binding</h3><p>{data.version.configuration.modelBinding.scope.kind === 'personal' ? 'Personal' : 'Workspace'} · {data.version.configuration.modelBinding.modelId}</p>
    <dl><dt>Scope ID</dt><dd>{data.version.configuration.modelBinding.scope.id}</dd><dt>Connection ID</dt><dd>{data.version.configuration.modelBinding.connectionId}</dd></dl>
    <h3>Default task limits</h3>
    <dl><dt>Total tokens</dt><dd>{data.version.configuration.limits.maxTotalTokens}</dd><dt>Duration (seconds)</dt><dd>{data.version.configuration.limits.maxDurationSeconds}</dd><dt>Turn limit</dt><dd>{data.version.configuration.limits.maxTurns}</dd><dt>Delegation depth</dt><dd>{data.version.configuration.limits.maxDelegationDepth}</dd></dl>
  </section>
  {#if data.canEdit}
    <section aria-labelledby="restore-heading">
      <h2 id="restore-heading">Restore this configuration</h2>
      <p>Restoring appends a new current version and retains all existing versions. Your current model access and the historical avatar are checked again.</p>
      <p><a href={`${base}/versions/${data.version.id}`} data-sveltekit-reload>Reload current version</a></p>
      {#if form?.error || transportError}<p role="alert">{transportError || form?.error}</p>{/if}
      <form method="POST" action="?/restore" use:enhance={submit}>
        <input type="hidden" name="expectedCurrentVersionId" value={form?.values.expectedCurrentVersionId ?? data.bot.currentVersion.id} />
        <input type="hidden" name="sourceVersionId" value={form?.values.sourceVersionId ?? data.version.id} />
        <label for="restore-rationale">Restoration rationale (optional)</label><textarea id="restore-rationale" name="rationale" maxlength="500" rows="2" value={form?.values.rationale ?? ''}></textarea>
        <button disabled={uncertain || form?.blocked}>Restore as new version</button>
      </form>
    </section>
  {/if}
</main>
<style>
  :global(body) { margin: 0; background: #0d1117; color: #f0f6fc; font-family: Inter, ui-sans-serif, system-ui, sans-serif; }
  main { max-width: 55rem; margin: auto; padding: 2rem; overflow-wrap: anywhere; } a { color: #a5d6ff; }
  section { padding: 1.5rem; border: 1px solid #30363d; border-radius: .75rem; margin-top: 1.5rem; } pre { white-space: pre-wrap; overflow-wrap: anywhere; font: inherit; }
  dl { display: grid; grid-template-columns: 1fr 2fr; gap: .75rem; } dd { margin: 0; } form { display: grid; gap: .75rem; }
  textarea, button { font: inherit; padding: .75rem; border: 1px solid #526171; border-radius: .4rem; color: inherit; background: #161b22; min-width: 0; } button { cursor: pointer; } button:disabled { cursor: not-allowed; opacity: .5; }
  [role='alert'] { color: #ffb4b4; } @media (max-width: 40rem) { main, section { padding: 1rem; } }
</style>
