<script lang="ts">
  import type { PageProps } from './$types';
  let { data, form }: PageProps = $props();
</script>
<svelte:head><title>Groups · {data.workspace.name} · OpenBot</title></svelte:head>
<main>
  <a href={`/app/workspaces/${encodeURIComponent(data.workspace.id)}`}>Back to {data.workspace.name}</a>
  <h1>Groups</h1>
  <p>Create a private group or discover groups shared with {data.workspace.name}.</p>
  {#if data.groups.length === 0}<p>No groups available yet.</p>{/if}
  <ul aria-label="Groups">
    {#each data.groups as group (group.id)}
      <li>
        <h2><a href={`/app/workspaces/${encodeURIComponent(data.workspace.id)}/groups/${encodeURIComponent(group.id)}`}>{group.name}</a></h2>
        <p>{group.description || 'No description yet.'}</p>
        <p>{group.visibility === 'private' ? 'Private' : 'Workspace discoverable'}</p>
        <p>{group.role ? `Your group role: ${group.role}` : 'Metadata only · Not a member'}</p>
      </li>
    {/each}
  </ul>
  <section aria-labelledby="create-heading">
    <h2 id="create-heading">Create group</h2>
    <form method="POST" action="?/create">
      <label for="group-name">Group name</label><input id="group-name" name="name" required maxlength="100" />
      <label for="group-description">Description</label><textarea id="group-description" name="description" maxlength="2000" rows="3"></textarea>
      <label for="group-visibility">Visibility</label>
      <select id="group-visibility" name="visibility"><option value="private" selected>Private</option><option value="workspace">Workspace discoverable</option></select>
      <p>Private groups are visible only to their members. Discoverable groups share their name and description with the workspace; membership is still required for access.</p>
      {#if form?.error}<p role="alert">{form.error}</p>{/if}
      <button type="submit">Create group</button>
    </form>
  </section>
</main>
<style>
 :global(body) { margin: 0; background: #0d1117; color: #f0f6fc; font-family: Inter, ui-sans-serif, system-ui, sans-serif; }
 main { max-width: 55rem; margin: auto; padding: 2rem; }
 a { color: #a5d6ff; }
 ul { list-style: none; padding: 0; }
 li, section { border: 1px solid #30363d; border-radius: .75rem; margin-top: 1.5rem; padding: 1.5rem; overflow-wrap: anywhere; }
 h2 { margin-top: 0; }
 form { display: grid; gap: .75rem; }
 input, textarea, select, button { border: 1px solid #8b949e; border-radius: .4rem; padding: .75rem; color: inherit; background: #161b22; font: inherit; min-width: 0; }
 button { cursor: pointer; justify-self: start; }
 [role='alert'] { color: #ffb4ac; }
 @media (max-width: 40rem) { main { padding: 1rem; } }
</style>
