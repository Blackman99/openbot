<script lang="ts">
 import type { PageProps } from './$types';
 import type { GroupMember } from '$lib/server/group-api.js';
 let { data, form }: PageProps = $props();
 const manager = $derived(data.group.role === 'owner' || data.group.role === 'admin');
 const eligibleOwners = $derived(data.members.filter((member) => member.role === 'owner' && member.hasWorkspaceAccess).length);
 function canManage(member: GroupMember) { return data.group.role === 'owner' || (data.group.role === 'admin' && member.role !== 'owner'); }
 function lastOwner(member: GroupMember) { return member.role === 'owner' && member.hasWorkspaceAccess && eligibleOwners === 1; }
</script>
<svelte:head><title>{data.group.name} · {data.workspace.name} · OpenBot</title></svelte:head>
<main>
 <a href={`/app/workspaces/${encodeURIComponent(data.workspace.id)}/groups`}>Back to groups</a>
 <h1>{data.group.name}</h1>
 <p>{data.group.description || 'No description yet.'}</p>
 <p>{data.group.visibility === 'private' ? 'Private' : 'Workspace discoverable'} · {data.workspace.name}</p>
 {#if form && 'error' in form}<p role="alert">{form.error}</p>{/if}
 {#if form && 'message' in form}<p role="status">{form.message}</p>{/if}
 {#if data.group.role === null}
  <p>Only group metadata is available. Ask a group owner or admin to add you.</p>
 {:else}
  <p>Your group role: {data.group.role}</p>
  <p><a href={`/app/workspaces/${data.workspace.id}/groups/${data.group.id}/bots`}>Group Bots</a></p>
  {#if manager}<p><a href={`/app/workspaces/${data.workspace.id}/groups/${data.group.id}/template`}>Export team template</a></p>{/if}
  <p><a href={`/app/workspaces/${data.workspace.id}/groups/${data.group.id}/routing`}>Routing settings</a></p>
  <p><a href={`/app/workspaces/${data.workspace.id}/groups/${data.group.id}/memories`}>Group memories</a></p>
  <p><a href={`/app/workspaces/${data.workspace.id}/groups/${data.group.id}/routines`}>One-time routines</a></p>
  {#if manager}
   <section aria-labelledby="settings-heading">
    <h2 id="settings-heading">Group settings</h2>
    <form method="POST" action="?/update">
     <label for="group-name">Group name</label><input id="group-name" name="name" required maxlength="100" value={data.group.name} />
     <label for="group-description">Description</label><textarea id="group-description" name="description" maxlength="2000" rows="3" value={data.group.description}></textarea>
     <label for="group-visibility">Visibility</label><select id="group-visibility" name="visibility" value={data.group.visibility}><option value="private">Private</option><option value="workspace">Workspace discoverable</option></select>
     <p>Workspace discoverability shares the name and description. People must still be added to the group for access.</p>
     <button type="submit">Save group settings</button>
    </form>
   </section>
  {:else}<p>Only group owners and admins can manage settings and people.</p>{/if}
  <section aria-labelledby="members-heading">
   <h2 id="members-heading">Group members</h2>
   <ul aria-label="Group members">
    {#each data.members as member (member.user.id)}
     <li>
      <h3>{member.user.displayName}{#if member.user.id === data.user.id} (you){/if}</h3>
      <p>{member.user.email}</p><p>Role: {member.role}</p>
      <p>Joined <time datetime={member.joinedAt}>{member.joinedAt}</time></p>
      {#if !member.hasWorkspaceAccess}<p>No current workspace access. This retained group membership grants no access until workspace membership is restored.</p>{/if}
      {#if canManage(member)}
       {#if lastOwner(member)}<p>Assign another eligible owner first to change this role or remove this member.</p>
       {:else}
        <form method="POST" action="?/changeRole">
         <input type="hidden" name="userId" value={member.user.id} />
         <label for={`role-${member.user.id}`}>Group role for {member.user.displayName}</label>
         <select id={`role-${member.user.id}`} name="role" value={member.role}><option value="member">Member</option><option value="admin">Admin</option>{#if data.group.role === 'owner'}<option value="owner">Owner</option>{/if}</select>
         <button type="submit" aria-label={`Change role for ${member.user.displayName}`}>Change role</button>
        </form>
        <details><summary>Remove {member.user.displayName}</summary>
         <p>Removing this person ends their group access. Their account and history are preserved.</p>
         {#if member.user.id === data.user.id}<p>You will leave this group and return to its workspace's groups.</p>{/if}
         <form method="POST" action="?/remove"><input type="hidden" name="userId" value={member.user.id} /><button class="remove" type="submit" aria-label={`Remove ${member.user.displayName} from group`}>Remove from group</button></form>
        </details>
       {/if}
      {/if}
     </li>
    {/each}
   </ul>
  </section>
  {#if manager}
   <section aria-labelledby="add-heading"><h2 id="add-heading">Add a person</h2>
    {#if data.candidates.length > 0}
     <form method="POST" action="?/add">
      <label for="new-member">Workspace member</label><select id="new-member" name="userId" required>{#each data.candidates as candidate (candidate.user.id)}<option value={candidate.user.id}>{candidate.user.displayName} · {candidate.user.email}</option>{/each}</select>
      <label for="new-role">New member role</label><select id="new-role" name="role"><option value="member" selected>Member</option><option value="admin">Admin</option>{#if data.group.role === 'owner'}<option value="owner">Owner</option>{/if}</select>
      <button type="submit">Add to group</button>
     </form>
    {:else}<p>All current workspace members already have a group membership.</p>{/if}
   </section>
  {/if}
 {/if}
</main>
<style>
 :global(body) { margin: 0; background: #0d1117; color: #f0f6fc; font-family: Inter, ui-sans-serif, system-ui, sans-serif; }
 main { max-width: 55rem; margin: auto; padding: 2rem; overflow-wrap: anywhere; }
 a { color: #a5d6ff; }
 ul { list-style: none; padding: 0; }
 section { border: 1px solid #30363d; border-radius: .75rem; margin-top: 1.5rem; padding: 1.5rem; }
 li { border-top: 1px solid #30363d; margin-top: 1.5rem; padding-top: 1.5rem; }
 h2 { margin-top: 0; }
 form { display: grid; gap: .75rem; }
 input, textarea, select, button { border: 1px solid #8b949e; border-radius: .4rem; padding: .75rem; color: inherit; background: #161b22; font: inherit; min-width: 0; }
 button { cursor: pointer; justify-self: start; }
 details { margin-top: 1.5rem; }
 summary { cursor: pointer; }
 .remove, [role='alert'] { color: #ffb4ac; }
 [role='status'] { color: #7ee787; }
 @media (max-width: 40rem) { main { padding: 1rem; } section { padding: 1rem; } }
</style>
