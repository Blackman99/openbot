<script lang="ts">
  import type { BotAclMember, BotAclRole } from '$lib/server/bot-acl-api.js';
  import type { PageProps } from './$types';
  let { data, form }: PageProps = $props();
  const roles: BotAclRole[] = ['owner', 'editor', 'user'];
  function promotionUnavailable(member: BotAclMember, role: BotAclRole) {
    return !member.hasWorkspaceAccess && roles.indexOf(role) < roles.indexOf(member.role);
  }
</script>
<svelte:head><title>{data.bot.name} permissions · OpenBot</title></svelte:head>
<main>
  <a href={`/app/workspaces/${data.workspace.id}/bots/${data.bot.id}`}>Back to Bot</a>
  <h1>Permissions for {data.bot.name}</h1>
  <p>Only Bot owners can change permissions. Workspace roles do not grant Bot access.</p>
  {#if form?.error}<p role="alert">{form.error}</p>{/if}
  {#if form?.message}<p role="status">{form.message}</p>{/if}
  <section aria-labelledby="discovery-heading">
    <h2 id="discovery-heading">Discovery</h2>
    <p>Workspace discovery shows the Bot's name, role and description. Instructions and settings remain available only to people with an explicit Bot role.</p>
    <form method="POST" action="?/visibility">
      <label for="visibility">Who can discover this Bot?</label>
      <select id="visibility" name="visibility" value={data.bot.visibility} required>
        <option value="private">Private — people with Bot access</option>
        <option value="workspace">Workspace discoverable</option>
      </select>
      <button>Save discovery settings</button>
    </form>
  </section>
  <section aria-labelledby="grant-heading">
    <h2 id="grant-heading">Grant access</h2>
    <p>Owners manage permissions. Editors can edit and use the Bot. Users can inspect and use it.</p>
    {#if data.candidates.length}
      <form method="POST" action="?/grant">
        <label for="grant-user">Workspace member</label>
        <select id="grant-user" name="userId" required>
          <option value="">Choose a person</option>
          {#each data.candidates as candidate (candidate.id)}
            <option value={candidate.id}>{candidate.displayName} · {candidate.email}</option>
          {/each}
        </select>
        <label for="grant-role">Bot role</label>
        <select id="grant-role" name="role" required value="user">
          <option value="user">User</option><option value="editor">Editor</option><option value="owner">Owner</option>
        </select>
        <button>Grant access</button>
      </form>
    {:else}<p>All current workspace members already have Bot access.</p>{/if}
  </section>
  <section aria-labelledby="people-heading">
    <h2 id="people-heading">People with Bot access</h2>
    <p>Keep at least one owner with current workspace access.</p>
    {#each data.members as member (member.user.id)}
      <section class="member" aria-label={`Access for ${member.user.displayName}`}>
        <h3>{member.user.displayName}{member.user.id === data.user.id ? ' (you)' : ''}</h3>
        <p>{member.user.email} · Current role: {member.role}</p>
        {#if !member.hasWorkspaceAccess}
          <p>No current workspace access. This retained grant cannot be used until the person rejoins the workspace. You can lower or revoke it.</p>
        {/if}
        <form method="POST" action="?/changeRole">
          <input type="hidden" name="userId" value={member.user.id} />
          <label for={`role-${member.user.id}`}>Role for {member.user.displayName}</label>
          <select id={`role-${member.user.id}`} name="role" value={member.role} required>
            {#each roles as role}<option value={role} disabled={promotionUnavailable(member, role)}>{role[0].toUpperCase() + role.slice(1)}</option>{/each}
          </select>
          <button>Save role</button>
        </form>
        <form method="POST" action="?/revoke">
          <input type="hidden" name="userId" value={member.user.id} />
          <button class="revoke">Revoke access</button>
        </form>
      </section>
    {/each}
  </section>
</main>
<style>
  :global(body) { margin: 0; background: #0d1117; color: #f0f6fc; font-family: Inter, ui-sans-serif, system-ui, sans-serif; }
  main { max-width: 52rem; margin: auto; padding: 2rem; overflow-wrap: anywhere; }
  a { color: #a5d6ff; }
  section { border: 1px solid #30363d; border-radius: .75rem; padding: 1.5rem; margin-top: 1.5rem; }
  .member { background: #161b22; }
  form { display: grid; gap: .7rem; margin-top: 1rem; }
  select, button { box-sizing: border-box; width: 100%; padding: .75rem; border-radius: .4rem; border: 1px solid #526171; font: inherit; }
  select { color: #f0f6fc; background: #0d1117; }
  button { background: #9ed0ff; color: #0d1117; cursor: pointer; }
  .revoke { background: transparent; color: #ffa6a6; border-color: #a55b61; }
  [role="alert"] { color: #ffb4b4; }
  [role="status"] { color: #a4eab1; }
  @media (max-width: 40rem) { main { padding: 1rem; } section { padding: 1rem; } }
</style>
