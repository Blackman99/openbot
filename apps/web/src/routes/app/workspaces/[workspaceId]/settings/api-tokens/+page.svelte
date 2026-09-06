<script lang="ts">
  import { enhance } from '$app/forms';
  import type { PageProps } from './$types';
  let { data, form }: PageProps = $props();
  let copyStatus = $state('');
  async function copyToken() {
    if (!form || !('secret' in form) || !form.secret) return;
    try { await navigator.clipboard.writeText(form.secret); copyStatus = 'Token copied.'; }
    catch { copyStatus = 'Select the token above and copy it manually.'; }
  }
</script>
<svelte:head><title>API tokens · {data.workspace.name} · OpenBot</title></svelte:head>
<main>
  <a href={`/app/workspaces/${encodeURIComponent(data.workspace.id)}`}>Back to {data.workspace.name}</a>
  <h1>API tokens</h1>
  <p>Your tokens for {data.workspace.name}. Tokens have only your current access to this workspace and its resources.</p>
  {#if form && 'error' in form}<p role="alert">{form.error}</p>{/if}
  {#if form && 'message' in form}<p role="status">{form.message}</p>{/if}
  {#if form && 'secret' in form && form.secret}
    <section aria-label="New token secret" class="secret">
      <label for="new-token">One-time token</label>
      <textarea id="new-token" readonly rows="2" value={form.secret}></textarea>
      <button type="button" onclick={copyToken}>Copy token</button>
      {#if copyStatus}<p role="status">{copyStatus}</p>{/if}
    </section>
  {/if}
  <section>
    <h2>Create a token</h2>
    <form method="POST" action="?/create" use:enhance={() => { copyStatus = ''; return async ({ update }) => { await update(); }; }}>
      <label for="token-name">Token name</label>
      <input id="token-name" name="name" maxlength="100" required placeholder="My automation" />
      <fieldset><legend>Scopes</legend>
        {#each data.availableScopes as scope}
          <label class="scope"><input type="checkbox" name="scope" value={scope} checked={scope === 'me:read'} />{scope}</label>
        {/each}
      </fieldset>
      <label for="token-expiry">Expires in</label>
      <select id="token-expiry" name="expiresInDays" value="30"><option value="1">1 day</option><option value="7">7 days</option><option value="30">30 days</option><option value="90">90 days</option><option value="365">365 days</option></select>
      <p>Scopes cannot be changed after creation. Choose only the access your integration needs.</p>
      <button type="submit">Create token</button>
    </form>
  </section>
  <section>
    <h2>Your tokens</h2>
    {#if data.tokens.length === 0}<p>You have no API tokens in this workspace.</p>{/if}
    <ul aria-label="Your API tokens">
      {#each data.tokens as token (token.id)}
        <li>
          <h3>{token.name}</h3>
          <p>{token.scopes.join(', ')}</p>
          <dl><dt>Created</dt><dd><time datetime={token.createdAt}>{token.createdAt}</time></dd><dt>Expires</dt><dd><time datetime={token.expiresAt}>{token.expiresAt}</time></dd><dt>Last used</dt><dd>{token.lastUsedAt ?? 'Never used'}</dd><dt>Status</dt><dd>{token.revokedAt ? 'Revoked' : Date.parse(token.expiresAt) <= Date.now() ? 'Expired' : 'Active'}</dd></dl>
          {#if !token.revokedAt}
            <form method="POST" action="?/revoke" use:enhance>
              <input type="hidden" name="tokenId" value={token.id} />
              <button type="submit" class="revoke" aria-label={`Revoke ${token.name}`}>Revoke token</button>
            </form>
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
  section { margin-top: 2rem; }
  form { display: grid; gap: .75rem; }
  input, select, textarea, button { border: 1px solid #8b949e; border-radius: .4rem; padding: .75rem; color: inherit; background: #161b22; font: inherit; min-width: 0; }
  input[type='checkbox'] { margin-right: .6rem; }
  fieldset { border: 1px solid #30363d; display: grid; grid-template-columns: repeat(auto-fit, minmax(12rem, 1fr)); gap: .75rem; padding: 1rem; }
  button { cursor: pointer; justify-self: start; }
  textarea { box-sizing: border-box; width: 100%; overflow-wrap: anywhere; margin: .75rem 0; }
  ul { list-style: none; padding: 0; }
  li, .secret { border: 1px solid #30363d; border-radius: .75rem; padding: 1.5rem; margin-top: 1rem; overflow-wrap: anywhere; }
  dl { display: grid; grid-template-columns: 6rem 1fr; gap: .5rem; }
  dd { margin: 0; }
  .revoke, [role='alert'] { color: #ffb4ac; }
  [role='status'] { color: #7ee787; }
  @media (max-width: 40rem) { main { padding: 1rem; } }
</style>
