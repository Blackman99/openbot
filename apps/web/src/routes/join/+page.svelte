<script lang="ts">
  import { onMount } from 'svelte';
  import { enhance } from '$app/forms';
  import type { SubmitFunction } from '@sveltejs/kit';
  import type { PageProps } from './$types';
  let { data, form }: PageProps = $props();
  let token = $state('');
  let ready = $state(false);
  let pending = $state(false);
  onMount(() => {
    const candidate = new URLSearchParams(window.location.hash.slice(1)).get('token') ?? '';
    token = /^[A-Za-z0-9_-]{43}$/u.test(candidate) ? candidate : '';
    window.history.replaceState(window.history.state, '', window.location.pathname + window.location.search);
    ready = true;
  });
  const submit: SubmitFunction = () => {
    pending = true;
    return async ({ update, formElement }) => {
      try { await update({ reset: false }); }
      finally { const password = formElement.querySelector<HTMLInputElement>('input[type="password"]'); if (password) password.value = ''; pending = false; }
    };
  };
</script>
<svelte:head><title>Join a workspace · OpenBot</title><meta name="referrer" content="same-origin" /></svelte:head>
<main>
  <h1>Join a workspace</h1>
  <noscript>Enable JavaScript to open this private invitation link.</noscript>
  {#if ready && !token}<p role="alert">Open the full invitation link shared by your workspace administrator.</p>{/if}
  {#if form && 'error' in form}<p role="alert">{form.error}</p>{/if}
  {#if data.user}
    <p>Signed in as {data.user.email}</p>
    <form method="POST" action="?/accept" use:enhance={submit}>
      <input type="hidden" name="token" value={token} />
      <button type="submit" disabled={!token || pending}>Join workspace</button>
    </form>
    <p>To use a different account, sign out from your workspace, then reopen the original invitation link.</p>
    <a href="/app">Your workspaces</a>
  {:else}
    <section>
      <h2>Create account and join</h2>
      <form method="POST" action="?/accept" use:enhance={submit}>
        <input type="hidden" name="token" value={token} />
        <label for="join-name">Display name</label><input id="join-name" name="displayName" autocomplete="name" required />
        <label for="join-email">Invited email</label><input id="join-email" name="email" type="email" autocomplete="email" required />
        <label for="join-password">New password</label><input id="join-password" name="password" type="password" autocomplete="new-password" minlength="12" required />
        <button type="submit" disabled={!token || pending}>Create account and join</button>
      </form>
    </section>
    <section>
      <h2>Already have an account?</h2>
      <form method="POST" action="?/signIn" use:enhance={submit}>
        <label for="sign-in-email">Account email</label><input id="sign-in-email" name="email" type="email" autocomplete="email" required />
        <label for="sign-in-password">Account password</label><input id="sign-in-password" name="password" type="password" autocomplete="current-password" required />
        <button type="submit" disabled={!token || pending}>Sign in to join</button>
      </form>
    </section>
  {/if}
</main>
<style>
  :global(body) { margin: 0; background: #0d1117; color: #f0f6fc; font-family: Inter, ui-sans-serif, system-ui, sans-serif; }
  main { max-width: 35rem; margin: auto; padding: 2rem; }
  section { border: 1px solid #30363d; border-radius: .75rem; margin-top: 1.5rem; padding: 1.5rem; }
  form { display: grid; gap: .75rem; }
  input, button { border: 1px solid #8b949e; border-radius: .4rem; padding: .75rem; color: inherit; background: #161b22; font: inherit; min-width: 0; }
  button { cursor: pointer; }
  button:disabled { opacity: .5; cursor: default; }
  a { color: #a5d6ff; }
  @media (max-width: 40rem) { main { padding: 1rem; } }
</style>
