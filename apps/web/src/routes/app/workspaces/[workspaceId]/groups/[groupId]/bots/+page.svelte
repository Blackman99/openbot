<script lang="ts">
  import BotAvatar from '$lib/BotAvatar.svelte';
  import type { PageProps } from './$types';
  let { data, form }: PageProps = $props();
  const base = $derived(`/app/workspaces/${data.workspace.id}/groups/${data.group.id}/bots`);
  let mode = $derived(form?.action === 'invite' ? (form.values.mode ?? 'future-only') : 'future-only');
  const pendingInvite = $derived(form?.action === 'invite' && form.uncertain);
</script>
<svelte:head><title>Bots · {data.group.name} · OpenBot</title></svelte:head>
<main>
  <a href={`/app/workspaces/${data.workspace.id}/groups/${data.group.id}`}>Back to {data.group.name}</a>
  <h1>Group Bots</h1>
  <p>{data.group.name} · {data.membership.activeCount} of {data.membership.maxActive} active Bots</p>
  <p>Group membership allows collaboration within its history boundary. Bot identity, configuration and model credentials keep their separate permissions.</p>
  {#if form?.error}<p role="alert">{form.error}</p>{/if}
  <p><a href={base}>Refresh memberships</a></p>
  {#if data.membership.canManage}
    <section aria-labelledby="invite-heading">
      <h2 id="invite-heading">Invite Bot</h2>
      <p>You need direct use access to invite a Bot. Removal requires group management access.</p>
      {#if pendingInvite && form}
        <p>Your previous choices are preserved. Retry this invitation unchanged, or refresh before starting a new invitation.</p>
        <dl><dt>Bot</dt><dd>{data.candidates.find((bot) => bot.id === form.values.botId)?.name ?? form.values.botId}</dd><dt>History choice</dt><dd>{form.values.mode ?? 'future-only'} {form.values.time ?? form.values.eventId ?? ''}</dd></dl>
        <form method="POST" action="?/invite">
          {#each Object.entries(form.values) as [name,value]}<input type="hidden" {name} {value} />{/each}
          <button>Retry invitation unchanged</button>
        </form>
      {:else if data.membership.activeCount >= data.membership.maxActive}
        <p>The group has eight active Bots. Remove a Bot before inviting another.</p>
      {:else if data.candidates.length}
        <form method="POST" action="?/invite">
          <input type="hidden" name="idempotencyKey" value={form?.action === 'invite' ? form.values.idempotencyKey : data.commands.invite} />
          <label for="invite-bot">Bot</label>
          <select id="invite-bot" name="botId" required value={form?.action === 'invite' ? form.values.botId : ''}>
            <option value="">Choose a Bot</option>
            {#each data.candidates as bot (bot.id)}<option value={bot.id}>{bot.name} · {bot.roleDescription}</option>{/each}
          </select>
          <label for="history-mode">History access</label>
          <select id="history-mode" name="mode" bind:value={mode}>
            <option value="future-only">Future messages only</option>
            <option value="since-event">Since an event</option>
            <option value="since-time">Since a time</option>
            <option value="all">All history</option>
          </select>
          {#if mode === 'since-event'}
            <label for="history-event">Event ID from this group's conversation</label>
            <input id="history-event" name="eventId" required maxlength="36" value={form?.action === 'invite' ? form.values.eventId ?? '' : ''} />
          {:else if mode === 'since-time'}
            <label for="history-time">Start time (ISO UTC)</label>
            <input id="history-time" name="time" required maxlength="24" placeholder="2026-09-05T00:00:00.000Z" value={form?.action === 'invite' ? form.values.time ?? '' : ''} />
            <p>Choose a past time. The history boundary is fixed when the Bot joins.</p>
          {/if}
          {#if mode === 'future-only'}<p>The Bot receives messages created after this invitation. Earlier messages remain outside its context even if edited later.</p>
          {:else}<p class="warning">This choice explicitly shares earlier group history, including any removal interval within the selected range.</p>{/if}
          <button disabled={form?.action === 'invite' && form.conflict}>Invite Bot</button>
        </form>
      {:else}<p>You have no Bots with direct use access. Ask a Bot owner for access before inviting one.</p>{/if}
    </section>
  {:else}<p>Only current group owners and admins can invite or remove Bots.</p>{/if}
  <section aria-labelledby="memberships-heading">
    <h2 id="memberships-heading">Bot memberships</h2>
    {#if data.membership.grants.length === 0}<p>No Bots have joined this group.</p>{/if}
    {#each data.membership.grants as grant (grant.id)}
      <article aria-label={`Membership for ${grant.bot.name}`}>
        <BotAvatar botId={grant.bot.id} workspaceId={data.workspace.id} name={grant.bot.name} />
        <h3>{grant.bot.name}</h3>
        {#if grant.bot.lifecycleState === 'deleted'}<p>Deleted Bot · Historical identity retained</p>{:else if grant.bot.lifecycleState === 'archived'}<p>Archived Bot · New work blocked</p>{/if}<p>{grant.bot.roleDescription}</p><p>{grant.bot.description}</p>
        <p>Invited by {grant.grantedBy.displayName} · <time datetime={grant.joined.at}>{grant.joined.at}</time></p>
        <p>History: {grant.history.mode === 'future-only' ? 'Future messages from this invitation' : grant.history.mode === 'all' ? 'All history explicitly shared' : grant.history.mode === 'since-event' ? `Since event ${grant.history.eventId}` : `Since ${grant.history.time}`}</p>
        {#if grant.closed}
          <p>Closed · {grant.closed.reason === 'removed' ? 'Removed from group' : grant.closed.reason === 'bot-access-revoked' ? 'Inviter lost direct Bot access' : 'Inviter lost workspace access'} · <time datetime={grant.closed.at}>{grant.closed.at}</time></p>
          <p>This membership no longer provides context. Reinvitation creates a separate history grant.</p>
        {:else}<p>Membership retained{grant.bot.lifecycleState === 'active' ? ' · Active' : ' · Use blocked'}</p>{#if grant.bot.lifecycleState === 'active'}<p><a href={`${base}/${grant.id}/context`}>View allowed context</a></p>{/if}{/if}
        {#if grant.bot.canInspect}<p><a href={`/app/workspaces/${data.workspace.id}/bots/${grant.bot.id}`}>View Bot details</a> · Uses your separate Bot access.</p>{/if}
        {#if data.membership.canManage}
          {#if form?.action === 'remove' && form.values.grantId === grant.id && form.uncertain}
            <form method="POST" action="?/remove">
              <input type="hidden" name="grantId" value={form.values.grantId} /><input type="hidden" name="idempotencyKey" value={form.values.idempotencyKey} />
              <button>Retry removal unchanged</button>
            </form>
          {:else if !grant.closed}
            <details><summary>Remove {grant.bot.name}</summary><p>Removing this Bot permanently closes this membership and its context access. A later invitation starts a new grant.</p>
              <form method="POST" action="?/remove">
                <input type="hidden" name="grantId" value={grant.id} /><input type="hidden" name="idempotencyKey" value={form?.action === 'remove' && form.values.grantId === grant.id ? form.values.idempotencyKey : data.commands.remove[grant.id]} />
                <button class="remove" disabled={form?.action === 'remove' && form.values.grantId === grant.id && form.conflict}>Confirm removal</button>
              </form>
            </details>
          {/if}
        {/if}
      </article>
    {/each}
  </section>
</main>
<style>
  :global(body) { margin: 0; background: #0d1117; color: #f0f6fc; font-family: Inter, ui-sans-serif, system-ui, sans-serif; }
  main { max-width: 52rem; margin: auto; padding: 2rem; overflow-wrap: anywhere; }
  a { color: #a5d6ff; }
  section, article { border: 1px solid #30363d; border-radius: .75rem; padding: 1.5rem; margin-top: 1.5rem; }
  article { background: #161b22; }
  form { display: grid; gap: .7rem; margin-top: 1rem; }
  input, select, button { box-sizing: border-box; width: 100%; padding: .75rem; border-radius: .4rem; border: 1px solid #526171; font: inherit; }
  input, select { color: #f0f6fc; background: #0d1117; }
  button { background: #9ed0ff; color: #0d1117; cursor: pointer; }
  button:disabled { opacity: .5; cursor: default; }
  .remove { background: transparent; color: #ffa6a6; border-color: #a55b61; }
  [role="alert"], .warning { color: #ffcf8a; }
  @media (max-width: 40rem) { main { padding: 1rem; } section, article { padding: 1rem; } }
</style>
