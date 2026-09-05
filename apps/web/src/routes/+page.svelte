<script lang="ts">
  interface PageState {
    status: 'ready' | 'unavailable';
  }

  let { data = { status: 'unavailable' } }: { data?: PageState } = $props();
</script>

<svelte:head>
  <title>OpenBot</title>
  <meta
    name="description"
    content="Self-hosted multi-bot collaboration with your compatible model endpoints."
  />
</svelte:head>

<main>
  <h1>OpenBot</h1>
  <p role="status" data-state={data.status}>
    {data.status === 'ready' ? 'Ready' : 'Unavailable'}
  </p>
</main>
