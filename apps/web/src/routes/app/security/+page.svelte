<script lang="ts">
  import type { PageProps } from './$types';
  let { data, form }: PageProps = $props();
</script>

<svelte:head><title>Security settings · OpenBot</title></svelte:head>
<main>
  <header>
    <div><p class="eyebrow">Your account</p><h1>Security settings</h1></div>
    <form method="POST" action="?/signOut"><button type="submit">Sign out</button></form>
  </header>
  <nav aria-label="Account"><a href="/app">Your workspaces</a></nav>
  <p>Signed in as {data.user.email}</p>
  {#if form && 'error' in form && form.error}<p role="alert">{form.error}</p>{/if}
  {#if data.oidcError}<p role="alert">{data.oidcError}</p>{/if}
  <section aria-labelledby="oidc-heading">
    <h2 id="oidc-heading">OIDC sign-in</h2>
    {#if !data.oidcEnabled}
      <p>OIDC sign-in is not available on this instance.</p>
    {:else if data.linked}
      <p role="status">OIDC identity linked.</p>
      <p>You can sign in using your linked identity.</p>
      {#if !data.canUnlink}<p id="unlink-help">This OIDC identity is your only sign-in method and cannot be removed.</p>{/if}
      <form method="POST" action="?/unlink">
        <button type="submit" disabled={!data.canUnlink} aria-describedby={!data.canUnlink ? 'unlink-help' : undefined}>Unlink OIDC identity</button>
      </form>
    {:else}
      {#if form && 'unlinked' in form && form.unlinked}<p role="status">OIDC identity unlinked.</p>{/if}
      <p>Link your account to an identity from this instance's sign-in provider.</p>
      <form method="POST" action="/auth/oidc/start">
        <input type="hidden" name="purpose" value="link" />
        <button type="submit">Link OIDC identity</button>
      </form>
    {/if}
  </section>
</main>
<style>
  :global(body) { margin: 0; background: #0d1117; color: #f0f6fc; font-family: Inter, ui-sans-serif, system-ui, sans-serif; }
  main { max-width: 55rem; margin: auto; padding: 2rem; }
  header { display: flex; align-items: center; justify-content: space-between; gap: 1rem; }
  .eyebrow { color: #7ee787; font-weight: 700; text-transform: uppercase; }
  section { margin-top: 2rem; border: 1px solid #30363d; border-radius: .75rem; padding: 1.5rem; }
  a { color: #a5d6ff; }
  button { border: 1px solid #8b949e; border-radius: .5rem; padding: .75rem 1rem; color: inherit; background: #161b22; font: inherit; cursor: pointer; }
  button:disabled { opacity: .5; cursor: default; }
  [role='alert'] { color: #ff7b72; }
  @media (max-width: 40rem) { main { padding: 1rem; } }
</style>
