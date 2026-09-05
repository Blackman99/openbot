<script lang="ts">
  import type { PageProps } from './$types';
  import type { WorkspaceMember } from '$lib/server/member-api.js';
  let { data, form }: PageProps = $props();
  const ownerCount = $derived(data.members.filter((member) => member.role === 'owner').length);
  function canManage(member: WorkspaceMember) {
    return data.workspace.role === 'owner' || (data.workspace.role === 'administrator' && member.role !== 'owner');
  }
  function isLastOwner(member: WorkspaceMember) { return member.role === 'owner' && ownerCount === 1; }
</script>

<svelte:head><title>Members · {data.workspace.name} · OpenBot</title></svelte:head>
<main>
  <a href={`/app/workspaces/${encodeURIComponent(data.workspace.id)}`}>Back to {data.workspace.name}</a>
  <h1>Workspace members</h1>
  <p>{data.workspace.name} · Your role: {data.workspace.role}</p>
  {#if form && 'error' in form}<p role="alert">{form.error}</p>{/if}
  {#if form && 'message' in form}<p role="status">{form.message}</p>{/if}
  {#if data.workspace.role === 'member'}<p>Only workspace owners and administrators can manage members.</p>{/if}
  <ul aria-label="Workspace members">
    {#each data.members as member (member.user.id)}
      <li>
        <h2>{member.user.displayName}{#if member.user.id === data.user.id} (you){/if}</h2>
        <p>{member.user.email}</p>
        <p>Role: {member.role}</p>
        <p>Joined <time datetime={member.joinedAt}>{member.joinedAt}</time></p>
        <p>{member.invitation ? `Invited by ${member.invitation.invitedBy.displayName}` : 'Direct membership'}</p>
        {#if canManage(member)}
          {#if isLastOwner(member)}
            <p>This is the last owner. Assign another owner first to change this role or remove this member.</p>
          {:else}
            <form method="POST" action="?/changeRole">
              <input type="hidden" name="userId" value={member.user.id} />
              <label for={`role-${member.user.id}`}>Role for {member.user.displayName}</label>
              <select id={`role-${member.user.id}`} name="role" value={member.role}>
                <option value="member">Member</option>
                <option value="administrator">Administrator</option>
                {#if data.workspace.role === 'owner'}<option value="owner">Owner</option>{/if}
              </select>
              <button type="submit" aria-label={`Change role for ${member.user.displayName}`}>Change role</button>
            </form>
            <details>
              <summary>Remove {member.user.displayName}</summary>
              <p>Removing this member ends their access to {data.workspace.name}. Their account and history are preserved.</p>
              {#if member.user.id === data.user.id}<p>You will leave this workspace and return to your available workspaces.</p>{/if}
              <form method="POST" action="?/remove">
                <input type="hidden" name="userId" value={member.user.id} />
                <button class="remove" type="submit" aria-label={`Remove ${member.user.displayName} from workspace`}>Remove from workspace</button>
              </form>
            </details>
          {/if}
        {/if}
      </li>
    {/each}
  </ul>
</main>
<style>
  :global(body) { margin: 0; background: #0d1117; color: #f0f6fc; font-family: Inter, ui-sans-serif, system-ui, sans-serif; }
  main { max-width: 55rem; margin: auto; padding: 2rem; }
  a { color: #a5d6ff; }
  ul { list-style: none; padding: 0; }
  li { border: 1px solid #30363d; border-radius: .75rem; margin-top: 1.5rem; padding: 1.5rem; overflow-wrap: anywhere; }
  h2 { margin-top: 0; }
  form { display: grid; gap: .75rem; }
  select, button { border: 1px solid #8b949e; border-radius: .4rem; padding: .75rem; color: inherit; background: #161b22; font: inherit; min-width: 0; }
  button { cursor: pointer; justify-self: start; }
  details { margin-top: 1.5rem; }
  summary { cursor: pointer; }
  .remove { color: #ffb4ac; border-color: #ffb4ac; }
  [role='status'] { color: #7ee787; }
  [role='alert'] { color: #ffb4ac; }
  @media (max-width: 40rem) { main { padding: 1rem; } }
</style>
