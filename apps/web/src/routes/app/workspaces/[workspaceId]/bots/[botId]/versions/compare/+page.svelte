<script lang="ts">
  import BotAvatar from '$lib/BotAvatar.svelte';
  import type { BotVersionField } from '$lib/server/bot-version-api.js';
  import type { PageProps } from './$types';
  let { data }: PageProps = $props();
  const base = $derived(`/app/workspaces/${data.workspace.id}/bots/${data.bot.id}`);
  const labels: Record<BotVersionField, string> = {
    name: 'Bot name', roleDescription: 'Role description', description: 'Description', instructions: 'System instructions',
    'modelBinding.scope.kind': 'Model scope', 'modelBinding.scope.id': 'Model scope ID', 'modelBinding.connectionId': 'Model connection', 'modelBinding.modelId': 'Model ID',
    avatarObjectId: 'Avatar', 'limits.maxTotalTokens': 'Total token limit', 'limits.maxDurationSeconds': 'Duration limit (seconds)', 'limits.maxTurns': 'Turn limit', 'limits.maxDelegationDepth': 'Delegation depth limit',
  };
</script>
<svelte:head><title>Compare versions · {data.bot.name} · OpenBot</title></svelte:head>
<main>
  <a href={`${base}/versions`}>Back to version history</a>
  <h1>Compare versions</h1>
  <p><a href={`${base}/versions/${data.fromVersion.id}`}>Version {data.fromVersion.number}</a> → <a href={`${base}/versions/${data.toVersion.id}`}>Version {data.toVersion.number}</a></p>
  {#if data.comparison.differences.length}
    <div class="table-wrap"><table>
      <thead><tr><th scope="col">Field</th><th scope="col">Before · Version {data.fromVersion.number}</th><th scope="col">After · Version {data.toVersion.number}</th></tr></thead>
      <tbody>{#each data.comparison.differences as difference (difference.field)}
        <tr>
          <th scope="row">{labels[difference.field]}</th>
          {#if difference.field === 'avatarObjectId'}
            <td><BotAvatar botId={data.bot.id} workspaceId={data.workspace.id} versionId={difference.before === null ? undefined : data.fromVersion.id} name={`${data.bot.name} before`} />{difference.before === null ? 'Default avatar' : 'Saved avatar'}</td>
            <td><BotAvatar botId={data.bot.id} workspaceId={data.workspace.id} versionId={difference.after === null ? undefined : data.toVersion.id} name={`${data.bot.name} after`} />{difference.after === null ? 'Default avatar' : 'Saved avatar'}</td>
          {:else}<td><pre>{difference.before}</pre></td><td><pre>{difference.after}</pre></td>{/if}
        </tr>
      {/each}</tbody>
    </table></div>
  {:else}<p>No configuration field differences between these versions.</p>{/if}
</main>
<style>
  :global(body) { margin: 0; background: #0d1117; color: #f0f6fc; font-family: Inter, ui-sans-serif, system-ui, sans-serif; }
  main { max-width: 70rem; margin: auto; padding: 2rem; overflow-wrap: anywhere; } a { color: #a5d6ff; }
  .table-wrap { overflow-x: auto; } table { width: 100%; border-collapse: collapse; table-layout: fixed; min-width: 35rem; } th, td { text-align: left; vertical-align: top; padding: 1rem; border: 1px solid #30363d; } th { background: #161b22; }
  pre { white-space: pre-wrap; overflow-wrap: anywhere; margin: 0; font: inherit; } @media (max-width: 40rem) { main { padding: 1rem; } }
</style>
