<script lang="ts">
  import type { Workspace } from '$lib/server/workspace-api.js';
  interface AppPageData {
    user: {
      displayName: string;
      email: string;
      id: string;
    };
    workspace: Workspace;
    workspaces: Workspace[];
  }

  let { data, form }: { data: AppPageData; form?: { action?: string; error?: string; saved?: boolean } | null } = $props();
</script>

<svelte:head>
  <title>{data.workspace.name} · OpenBot</title>
  <meta name="description" content="Your private OpenBot workspace." />
</svelte:head>

<main>
  <header>
    <div>
      <p class="eyebrow">Workspace</p>
      <h1>{data.workspace.name}</h1>
    </div>
    <form method="POST" action="?/signOut">
      <button type="submit">Sign out</button>
    </form>
  </header>

  <nav aria-label="Workspaces">
    <h2>Your workspaces</h2>
    <ul>
      {#each data.workspaces as workspace (workspace.id)}
        <li><a href={`/app/workspaces/${encodeURIComponent(workspace.id)}`} aria-current={workspace.id === data.workspace.id ? 'page' : undefined}>{workspace.name}</a></li>
      {/each}
    </ul>
  </nav>

  <section aria-labelledby="owner-heading">
    <h2 id="owner-heading">Signed in as</h2>
    <p>{data.user.displayName}</p>
    <p>{data.user.email}</p>
    <p>Your role: {data.workspace.role}</p>
  </section>

  <section aria-labelledby="settings-heading">
    <h2 id="settings-heading">Workspace settings</h2>
    {#if data.workspace.role === 'owner' || data.workspace.role === 'administrator'}
      <form method="POST" action="?/updateWorkspace">
        <label for="workspace-name">Workspace name</label>
        <input id="workspace-name" name="name" required maxlength="100" value={data.workspace.name} />
        <label for="workspace-description">Workspace description</label>
        <textarea id="workspace-description" name="description" maxlength="2000" rows="4" value={data.workspace.description}></textarea>
        {#if form?.action === 'update' && form.error}<p role="alert">{form.error}</p>{/if}
        {#if form?.action === 'update' && form.saved}<p role="status">Workspace settings saved.</p>{/if}
        <button type="submit">Save settings</button>
      </form>
    {:else}
      <p>{data.workspace.description || 'No description yet.'}</p>
      <p>Only workspace owners and administrators can edit settings.</p>
    {/if}
  </section>

  <section aria-labelledby="create-heading">
    <h2 id="create-heading">Create a workspace</h2>
    <form method="POST" action="?/createWorkspace">
      <label for="new-workspace-name">New workspace name</label>
      <input id="new-workspace-name" name="name" required maxlength="100" />
      <label for="new-workspace-description">New workspace description</label>
      <textarea id="new-workspace-description" name="description" maxlength="2000" rows="3"></textarea>
      {#if form?.action === 'create' && form.error}<p role="alert">{form.error}</p>{/if}
      <button type="submit">Create workspace</button>
    </form>
  </section>
</main>

<style>
  :global(body) {
    margin: 0;
    background: #0d1117;
    color: #f0f6fc;
    font-family: Inter, ui-sans-serif, system-ui, sans-serif;
  }
  main {
    margin: 0 auto;
    max-width: 70rem;
    padding: 2rem;
  }
  header {
    align-items: center;
    display: flex;
    justify-content: space-between;
  }
  .eyebrow {
    color: #7ee787;
    font-weight: 700;
    text-transform: uppercase;
  }
  section {
    border: 1px solid #30363d;
    border-radius: 0.75rem;
    margin-top: 2rem;
    padding: 1.5rem;
  }
  button {
    background: transparent;
    border: 1px solid #8b949e;
    border-radius: 0.5rem;
    color: inherit;
    cursor: pointer;
    font: inherit;
    padding: 0.65rem 1rem;
  }
  nav { margin-top: 2rem; }
  ul { display: flex; flex-wrap: wrap; gap: 1rem; list-style: none; padding: 0; }
  a { color: #a5d6ff; }
  a[aria-current='page'] { color: #7ee787; font-weight: 700; }
  section form { display: grid; gap: 0.75rem; }
  input, textarea { background: #161b22; border: 1px solid #8b949e; border-radius: 0.4rem; color: inherit; font: inherit; padding: 0.75rem; min-width: 0; }
  section button { justify-self: start; }
  @media (max-width: 40rem) { main { padding: 1rem; } header { gap: 1rem; } }
</style>
