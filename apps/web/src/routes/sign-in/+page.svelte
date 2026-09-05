<script lang="ts">
  interface SignInForm {
    email?: string;
    error?: string;
  }

  let { form = {} }: { form?: SignInForm } = $props();
</script>

<svelte:head>
  <title>Sign in · OpenBot</title>
  <meta name="description" content="Sign in to your self-hosted OpenBot instance." />
</svelte:head>

<main>
  <section aria-labelledby="sign-in-heading">
    <p class="eyebrow">Welcome back</p>
    <h1 id="sign-in-heading">Sign in to OpenBot</h1>

    {#if form?.error}
      <p class="error" role="alert">{form.error}</p>
    {/if}

    <form method="POST">
      <label>
        Email
        <input
          autocomplete="email"
          maxlength="320"
          name="email"
          required
          type="email"
          value={form?.email ?? ''}
        />
      </label>
      <label>
        Password
        <input autocomplete="current-password" name="password" required type="password" />
      </label>
      <button type="submit">Sign in</button>
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
    display: grid;
    min-height: 100vh;
    place-items: center;
    padding: 1.5rem;
  }
  section {
    width: min(100%, 30rem);
  }
  .eyebrow {
    color: #79c0ff;
    font-weight: 700;
    text-transform: uppercase;
  }
  form,
  label {
    display: grid;
    gap: 0.5rem;
  }
  form {
    gap: 1rem;
    margin-top: 2rem;
  }
  input,
  button {
    border: 1px solid #30363d;
    border-radius: 0.5rem;
    font: inherit;
    padding: 0.8rem;
  }
  input {
    background: #161b22;
    color: inherit;
  }
  button {
    background: #1f6feb;
    color: white;
    cursor: pointer;
    font-weight: 700;
  }
  .error {
    color: #ff7b72;
  }
</style>
