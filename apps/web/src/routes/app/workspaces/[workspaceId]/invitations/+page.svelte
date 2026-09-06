<script lang="ts">
  import type { PageProps } from './$types';
  let { data, form }: PageProps = $props();
</script>

<svelte:head><title>Invitations · {data.workspace.name} · OpenBot</title></svelte:head>
<main>
  <a href={`/app/workspaces/${encodeURIComponent(data.workspace.id)}`}>Back to {data.workspace.name}</a>
  <h1>Workspace invitations</h1>
  <p>Invite someone by email and share their link privately.</p>
  {#if form && 'error' in form}<p role="alert">{form.error}</p>{/if}
  {#if form && 'invitationLink' in form}
    <section aria-label="New invitation">
      <label for="invitation-link">Invitation link</label>
      <input id="invitation-link" readonly value={form.invitationLink} onclick={(event) => event.currentTarget.select()} />
      <p>Copy this link now. It is only shown once.</p>
    </section>
  {/if}
  {#if form && 'revoked' in form}<p role="status">Invitation revoked.</p>{/if}
  <section>
    <h2>Create invitation</h2>
    <form method="POST" action="?/create">
      <label for="invite-email">Invited email</label><input id="invite-email" name="email" type="email" autocomplete="off" required />
      <label for="invite-role">Target role</label>
      <select id="invite-role" name="role"><option value="member">Member</option><option value="administrator">Administrator</option></select>
      <label for="invite-expiry">Expires in days</label><input id="invite-expiry" name="expiresInDays" type="number" min="1" max="30" value="7" required />
      <button type="submit">Create invitation</button>
    </form>
  </section>
  <section>
    <h2>Invitations</h2>
    {#if data.invitations.length === 0}<p>No invitations yet.</p>{/if}
    <ul>
      {#each data.invitations as invitation (invitation.id)}
        <li>
          <strong>{invitation.email}</strong><p>{invitation.role} · Expires {invitation.expiresAt}</p>
          {#if invitation.revokedAt}<p>Revoked</p>
          {:else if invitation.consumedAt}<p>Accepted</p>
          {:else}
            <form method="POST" action="?/revoke"><input type="hidden" name="invitationId" value={invitation.id} /><button type="submit" aria-label={`Revoke invitation for ${invitation.email}`}>Revoke invitation</button></form>
          {/if}
        </li>
      {/each}
    </ul>
  </section>
</main>
<style>
  :global(body) { margin: 0; background: #0d1117; color: #f0f6fc; font-family: Inter, ui-sans-serif, system-ui, sans-serif; }
  main { max-width: 55rem; margin: auto; padding: 2rem; }
  a { color: #a5d6ff; }
  section { border: 1px solid #30363d; border-radius: .75rem; margin-top: 1.5rem; padding: 1.5rem; }
  form { display: grid; gap: .75rem; }
  input, select, button { border: 1px solid #8b949e; border-radius: .4rem; padding: .75rem; color: inherit; background: #161b22; font: inherit; min-width: 0; }
  #invitation-link { display: block; box-sizing: border-box; width: 100%; margin-top: .75rem; }
  button { cursor: pointer; justify-self: start; }
  ul { list-style: none; padding: 0; }
  li { padding: 1rem 0; border-bottom: 1px solid #30363d; overflow-wrap: anywhere; }
  @media (max-width: 40rem) { main { padding: 1rem; } }
</style>
