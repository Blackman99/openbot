<script lang="ts">import type {PageProps} from './$types';let {data}:PageProps=$props();</script>
<svelte:head><title>Deleted Bots · OpenBot</title></svelte:head>
<main>
  <a href={`/app/workspaces/${data.workspace.id}/bots`}>Back to Bots</a>
  <h1>Deleted Bots</h1>
  <p>Only Bots you currently own appear here. Open a Bot to see its recovery deadline and undo deletion.</p>
  {#if data.bots.length===0}<p>No deleted Bots available for your ownership.</p>{/if}
  <ul>{#each data.bots as bot (bot.id)}<li><a href={`/app/workspaces/${data.workspace.id}/bots/${bot.id}/lifecycle`}>{bot.name}</a> · Deleted Bot</li>{/each}</ul>
  <p>Soft deletion retains configuration and historical identity. It does not physically erase data.</p>
</main>
<style>:global(body){margin:0;background:#0d1117;color:#f0f6fc;font-family:Inter,ui-sans-serif,system-ui,sans-serif;}main{max-width:50rem;margin:auto;padding:2rem;}a{color:#a5d6ff;}li{margin:1rem 0;}</style>
