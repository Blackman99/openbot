<script lang="ts">
  import type { PageProps } from './$types';
  let { data, form }: PageProps = $props();
</script>
<svelte:head><title>Conversations · OpenBot</title></svelte:head>
<main>
  <a href={`/app/workspaces/${data.workspace.id}`}>Back to workspace</a>
  <h1>Conversations</h1>
  <p>Persistent message history for your groups and private Bot conversations.</p>
  {#if form?.error}<p role="alert">{form.error}</p>{/if}
  {#each ['group', 'direct-bot'] as kind}
    <section aria-label={kind === 'group' ? 'Group conversations' : 'Private Bot conversations'}>
      <h2>{kind === 'group' ? 'Group conversations' : 'Private Bot conversations'}</h2>
      {#if kind === 'direct-bot'}<p>A direct conversation is private to the person who opens it.</p>{/if}
      {#each data.subjects.filter((subject) => subject.kind === kind) as subject (subject.id)}
        <form method="POST" action="?/open">
          <input type="hidden" name="kind" value={subject.kind} />
          <input type="hidden" name="subjectId" value={subject.id} />
          <button>Open {subject.name}</button>
        </form>
      {:else}<p>No {kind === 'group' ? 'groups' : 'Bots'} with explicit access are available.</p>{/each}
    </section>
  {/each}
</main>
<style>
  :global(body) { margin: 0; background: #0d1117; color: #f0f6fc; font-family: Inter, ui-sans-serif, system-ui, sans-serif; }
  main { max-width: 55rem; margin: auto; padding: 2rem; overflow-wrap: anywhere; }
  a { color: #a5d6ff; }
  section { margin-top: 1.5rem; padding: 1.5rem; border: 1px solid #30363d; border-radius: .75rem; }
  form { margin-top: 1rem; }
  button { padding: .75rem 1rem; border: 0; border-radius: .4rem; background: #9ed0ff; color: #0d1117; font: inherit; cursor: pointer; }
  [role="alert"] { color: #ffb4b4; }
  @media (max-width: 40rem) { main { padding: 1rem; } section { padding: 1rem; } }
</style>
