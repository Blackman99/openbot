<script lang="ts">
  import BotBindingStatus from '$lib/BotBindingStatus.svelte';
  import type { BotDetail, BotSummary } from '$lib/server/bot-api.js';
  import type { PageProps } from './$types';
  let { data }: PageProps = $props();
  function detail(bot: BotSummary | BotDetail): bot is BotDetail { return bot.accessRole !== null && 'currentVersion' in bot; }
  let version = $derived(detail(data.bot) ? data.bot.currentVersion : undefined);
</script>
<svelte:head><title>{data.bot.name} · OpenBot</title></svelte:head>
<main>
  <a href={`/app/workspaces/${data.workspace.id}/bots`}>Back to Bots</a>
  <h1>{data.bot.name}</h1>
  <p>{data.bot.roleDescription}</p>
  <p>{data.bot.description || 'No description yet.'}</p>
  <p>{data.bot.visibility === 'private' ? 'Private' : 'Workspace discoverable'}</p>
  <BotBindingStatus status={data.bot.bindingStatus} />
  {#if data.bot.accessRole === 'owner'}
    <p><a href={`/app/workspaces/${data.workspace.id}/bots/${data.bot.id}/permissions`}>Manage permissions</a></p>
  {/if}
  {#if version}
    <p>Your Bot role: {data.bot.accessRole}</p>
    <p class="identifier">Bot ID: {data.bot.id}</p>
    <section aria-labelledby="version-heading">
      <h2 id="version-heading">Version {version.number}</h2>
      <p>{version.rationale} · {version.author.displayName} · <time datetime={version.createdAt}>{version.createdAt}</time></p>
      <h3>System instructions</h3><pre>{version.configuration.instructions}</pre>
      <h3>Model binding</h3>
      <p>{version.configuration.modelBinding.scope.kind === 'personal' ? 'Personal model' : 'Workspace model'} · {version.configuration.modelBinding.modelId}</p>
      <p class="identifier">Connection: {version.configuration.modelBinding.connectionId}</p>
      <h3>Saved default task limits</h3>
      <dl>
        <dt>Total tokens (input + output)</dt><dd>{version.configuration.limits.maxTotalTokens}</dd>
        <dt>Duration (seconds)</dt><dd>{version.configuration.limits.maxDurationSeconds}</dd>
        <dt>Turns</dt><dd>{version.configuration.limits.maxTurns}</dd>
        <dt>Delegation depth</dt><dd>{version.configuration.limits.maxDelegationDepth}{version.configuration.limits.maxDelegationDepth === 0 ? ' · Delegation disabled' : ''}</dd>
      </dl>
      <p>Task execution is not available yet. These limits are saved for future tasks.</p>
    </section>
  {:else}
    <p>Only Bot metadata is available. Workspace membership does not grant access to this Bot's configuration.</p>
  {/if}
</main>
<style>
  :global(body) { margin: 0; background: #0d1117; color: #f0f6fc; font-family: Inter, ui-sans-serif, system-ui, sans-serif; }
  main { max-width: 55rem; margin: auto; padding: 2rem; overflow-wrap: anywhere; }
  a { color: #a5d6ff; }
  section { border: 1px solid #30363d; border-radius: .75rem; margin-top: 1.5rem; padding: 1.5rem; }
  pre { background: #161b22; border-radius: .5rem; padding: 1rem; font: inherit; white-space: pre-wrap; overflow-wrap: anywhere; }
  dl { display: grid; grid-template-columns: 1fr 1fr; gap: .75rem; }
  dd { margin: 0; }
  .identifier { color: #a6b0bc; font-size: .9rem; }
  @media (max-width: 40rem) { main { padding: 1rem; } section { padding: 1rem; } }
</style>
