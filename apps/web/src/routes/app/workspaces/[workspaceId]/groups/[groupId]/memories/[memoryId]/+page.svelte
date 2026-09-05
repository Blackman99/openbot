<script lang="ts">
  import MemorySource from '$lib/components/MemorySource.svelte';
  import type { PageProps } from './$types';
  let { data }: PageProps = $props();
</script>
<svelte:head><title>Saved memory · {data.group.name} · OpenBot</title></svelte:head>
<main><a href={`/app/workspaces/${data.workspace.id}/groups/${data.group.id}/memories${data.grantId ? `?grantId=${encodeURIComponent(data.grantId)}` : ''}`}>Back to group memories</a><h1>Saved memory</h1><p>{data.group.name}</p><MemorySource memory={data.memory}/><p>This saved version is available only while its current source remains unchanged and visible.</p></main>
<style>
  :global(body) { margin: 0; background: #0d1117; color: #f0f6fc; font-family: Inter, ui-sans-serif, system-ui, sans-serif; } main { max-width: 55rem; margin: auto; padding: 2rem; overflow-wrap: anywhere; } a { color: #a5d6ff; }
</style>
