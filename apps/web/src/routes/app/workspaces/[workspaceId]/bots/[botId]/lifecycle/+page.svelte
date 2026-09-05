<script lang="ts">
  import type {PageProps} from './$types';
  let {data,form}:PageProps=$props();
  let state=$derived(data.lifecycle.state);
</script>
<svelte:head><title>Manage {data.bot.name} · OpenBot</title></svelte:head>
<main>
  <a href={`/app/workspaces/${data.workspace.id}/bots/${data.bot.id}`}>Back to Bot</a>
  <h1>Manage {data.bot.name}</h1>
  <p role="status">Current state: {state}</p>
  <p>Bot ID: {data.bot.id}</p>
  {#if form && 'error' in form}<p role="alert">{form.error}</p>{/if}
  {#if form && 'message' in form}<p role="status">{form.message}</p>{/if}
  {#if state === 'deleted'}
    <h2>Deleted Bot</h2>
    <p>Deleted at <time datetime={data.lifecycle.deletedAt ?? ''}>{data.lifecycle.deletedAt}</time>.</p>
    <p>Recovery deadline: <time datetime={data.lifecycle.recoveryDeadline ?? ''}>{data.lifecycle.recoveryDeadline}</time>.</p>
    <p>Undo returns this Bot to its previous {data.lifecycle.preDeletedState} state. Only a current owner can recover it before this deadline.</p>
    <form method="POST" action="?/undoDelete"><button>Undo deletion</button></form>
  {:else}
    {#if state === 'active'}
      <h2>Archive Bot</h2>
      <p>Archiving stops new work. Existing configuration and history remain readable with current access.</p>
      <form method="POST" action="?/archive"><button>Archive Bot</button></form>
    {:else}
      <h2>Restore Bot</h2>
      <p>Restoring to active checks your current access to its enabled, verified model connection.</p>
      <form method="POST" action="?/restore"><button>Restore Bot</button></form>
    {/if}
    <h2>Delete Bot</h2>
    <p>Deletion hides this Bot from default lists and blocks new work. Owners have 30 days to undo deletion.</p>
    <form method="POST" action="?/delete"><button>Delete Bot</button></form>
  {/if}
  <p>Configuration, avatars and historical identity are retained. This operation does not physically erase data.</p>
  <p><a href={`/app/workspaces/${data.workspace.id}/bots/deleted`}>Deleted Bots and recovery</a></p>
</main>
<style>
  :global(body){margin:0;background:#0d1117;color:#f0f6fc;font-family:Inter,ui-sans-serif,system-ui,sans-serif;}
  main{max-width:50rem;margin:auto;padding:2rem;overflow-wrap:anywhere;}a{color:#a5d6ff;}h2{margin-top:2rem;}button{font:inherit;color:inherit;background:#161b22;border:1px solid #8b949e;border-radius:.4rem;padding:.75rem;cursor:pointer;}[role='alert']{color:#ffb4ac;}time{font-variant-numeric:tabular-nums;}
</style>
