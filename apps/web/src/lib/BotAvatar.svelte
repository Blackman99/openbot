<script lang="ts">
  let { botId, workspaceId, versionId, name }: { botId: string; workspaceId: string; versionId?: string; name: string } = $props();
  let failedUrl = $state('');
  const source = $derived(versionId ? `/app/workspaces/${workspaceId}/bots/${botId}/avatar?versionId=${versionId}` : '');
  const seed = $derived(botId.replaceAll('-', ''));
  const color = $derived(`#${seed.slice(0, 6)}`);
</script>
{#if source && failedUrl !== source}
  <img src={source} alt={`Avatar for ${name}`} width="64" height="64" onerror={() => { failedUrl = source; }} />
{:else}
  <svg width="64" height="64" viewBox="0 0 5 5" role="img" aria-label={`Default avatar for ${name}`}>
    <rect width="5" height="5" fill="#dbeafe" />
    {#each [0, 1, 2, 3, 4] as y}
      {#each [0, 1, 2, 3, 4] as x}
        {#if parseInt(seed[y * 3 + Math.min(x, 4 - x)] ?? '0', 16) % 2 === 0}<rect {x} {y} width="1" height="1" fill={color} />{/if}
      {/each}
    {/each}
  </svg>
{/if}
<style>img, svg { border-radius: .75rem; object-fit: contain; background: #161b22; flex-shrink: 0; }</style>
