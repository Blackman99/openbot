<script lang="ts">
  interface SetupForm {
    displayName?: string;
    email?: string;
    error?: string;
  }

  let { form = {} }: { form?: SetupForm } = $props();
</script>

<svelte:head>
  <title>Set up OpenBot</title>
  <meta name="description" content="Create the local owner for this OpenBot instance." />
</svelte:head>

<main>
  <section aria-labelledby="setup-heading">
    <p class="eyebrow">First run</p>
    <h1 id="setup-heading">Set up OpenBot</h1>
    <p>Create the local owner and your first workspace.</p>

    {#if form?.error}
      <p class="error" role="alert">{form.error}</p>
    {/if}

    <form method="POST">
      <label>
        Display name
        <input
          autocomplete="name"
          maxlength="100"
          name="displayName"
          required
          value={form?.displayName ?? ''}
        />
      </label>
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
        Setup token
        <input autocomplete="off" name="setupToken" required type="password" />
      </label>
      <label>
        Password
        <input
          autocomplete="new-password"
          minlength="12"
          name="password"
          required
          type="password"
        />
      </label>
      <button type="submit">Create owner</button>
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
    color: #7ee787;
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
    background: #238636;
    color: white;
    cursor: pointer;
    font-weight: 700;
  }
  .error {
    color: #ff7b72;
  }
</style>
