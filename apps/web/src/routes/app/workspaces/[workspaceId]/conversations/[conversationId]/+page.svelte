<script lang="ts">
  import { enhance } from '$app/forms';
  import type { SubmitFunction } from '@sveltejs/kit';
  import type { PageProps } from './$types';
  let { data, form }: PageProps = $props();
  let transportError = $state('');
  let base = $derived(`/app/workspaces/${data.workspace.id}/conversations/${data.conversation.id}`);
  function matches(action: string, id = '') {
    return form?.action === action && (form.values.messageId ?? '') === id;
  }
  function value(action: string, id: string, field: string, fallback: string) {
    return matches(action, id) ? form?.values[field] ?? fallback : fallback;
  }
  function blocked(action: string, id = '') {
    return matches(action, id) && form?.conflict;
  }
  function actionUrl(action: string) {
    return `?/${action}&limit=${data.limit}${data.cursor ? `&cursor=${encodeURIComponent(data.cursor)}` : ''}`;
  }
  const submit: SubmitFunction = ({ formElement }) => async ({ result, update }) => {
    if (result.type === 'error') {
      transportError = 'The change could not be confirmed. Retry the unchanged form with the same command key.';
      return;
    }
    transportError = '';
    if (result.type === 'redirect') formElement.reset();
    await update();
  };
</script>
<svelte:head><title>Conversation history · OpenBot</title></svelte:head>
<main>
  <a href={`/app/workspaces/${data.workspace.id}/conversations`}>Back to conversations</a>
  <h1>{data.conversation.subject.kind === 'group' ? 'Group conversation' : 'Private Bot conversation'}</h1>
  {#if data.conversation.subject.kind === 'direct-bot'}<p>This history is private to its human creator.</p><p>Bot ID: {data.conversation.subject.id}</p>
  {#if data.conversation.botLifecycleState === 'deleted'}<p>Deleted Bot · Historical identity retained</p>{:else if data.conversation.botLifecycleState === 'archived'}<p>Archived Bot · New work blocked</p>{/if}{/if}
  <nav aria-label="Message pages">
    <a href={`${base}?limit=${data.limit}`}>Refresh messages</a>
    {#if data.nextCursor}<a href={`${base}?cursor=${encodeURIComponent(data.nextCursor)}&limit=${data.limit}`}>Next page</a>{/if}
  </nav>
  {#if transportError || form?.error}<p role="alert">{transportError || form?.error}</p>{/if}
  {#each data.messages as message (message.id)}
    <article id={`message-${message.id}`} aria-label={`Message by ${message.author.displayName}`}>
      <h2>{message.author.displayName}</h2>
      <p>Version {message.version} · <time datetime={message.createdAt}>{message.createdAt}</time></p>
      {#if message.deleted}<p><strong>Deleted message</strong> · {message.reason}</p>{:else}<pre>{message.body}</pre>{/if}
      {#if message.canAudit}<a href={`${base}/messages/${message.id}/versions`}>View versions</a>{/if}
      {#if message.canEdit}
        <details open={matches('edit', message.id)}>
          <summary>Edit message</summary>
          <form method="POST" action={actionUrl('edit')} use:enhance={submit}>
            <input type="hidden" name="messageId" value={message.id} />
            <input type="hidden" name="idempotencyKey" value={value('edit', message.id, 'idempotencyKey', data.commands.messages[message.id].edit)} />
            <input type="hidden" name="expectedVersion" value={value('edit', message.id, 'expectedVersion', String(message.version))} />
            <label for={`edit-${message.id}`}>Edit message text</label>
            <textarea id={`edit-${message.id}`} name="body" rows="4" maxlength="32000" required value={value('edit', message.id, 'body', message.body ?? '')}></textarea>
            <button disabled={blocked('edit', message.id)}>Save edit</button>
          </form>
        </details>
      {/if}
      {#if message.canDelete}
        <details open={matches('tombstone', message.id)}>
          <summary>Delete message</summary>
          <form method="POST" action={actionUrl('tombstone')} use:enhance={submit}>
            <input type="hidden" name="messageId" value={message.id} />
            <input type="hidden" name="idempotencyKey" value={value('tombstone', message.id, 'idempotencyKey', data.commands.messages[message.id].tombstone)} />
            <input type="hidden" name="expectedVersion" value={value('tombstone', message.id, 'expectedVersion', String(message.version))} />
            <label for={`reason-${message.id}`}>Reason for deletion{message.author.id === data.user.id ? ' (optional)' : ' (required)'}</label>
            <textarea id={`reason-${message.id}`} name="reason" rows="2" maxlength="500" required={message.author.id !== data.user.id} value={value('tombstone', message.id, 'reason', '')}></textarea>
            <p>Deletion replaces the message with a visible marker. Authorized people can still inspect its versions.</p>
            <button disabled={blocked('tombstone', message.id)}>Confirm deletion</button>
          </form>
        </details>
      {/if}
    </article>
  {:else}<p>No messages on this page.</p>{/each}
  {#if data.canWrite}
    <section aria-labelledby="write-heading">
      <h2 id="write-heading">Add a message</h2>
      <form method="POST" action={actionUrl('append')} use:enhance={submit}>
        <input type="hidden" name="idempotencyKey" value={value('append', '', 'idempotencyKey', data.commands.append)} />
        <label for="new-message">Message</label>
        <textarea id="new-message" name="body" rows="5" maxlength="32000" required value={value('append', '', 'body', '')}></textarea>
        <button disabled={blocked('append')}>Send message</button>
      </form>
    </section>
  {/if}
</main>
<style>
  :global(body) { margin: 0; background: #0d1117; color: #f0f6fc; font-family: Inter, ui-sans-serif, system-ui, sans-serif; }
  main { max-width: 55rem; margin: auto; padding: 2rem; overflow-wrap: anywhere; }
  a { color: #a5d6ff; }
  nav { display: flex; flex-wrap: wrap; gap: 1.5rem; margin: 1rem 0; }
  article, section { border: 1px solid #30363d; border-radius: .75rem; margin-top: 1.5rem; padding: 1.5rem; }
  pre { font: inherit; white-space: pre-wrap; overflow-wrap: anywhere; line-height: 1.5; }
  details { margin-top: 1rem; } summary { cursor: pointer; color: #a5d6ff; }
  form { display: grid; gap: .75rem; margin-top: 1rem; }
  textarea, button { padding: .75rem; border: 1px solid #526171; border-radius: .4rem; font: inherit; }
  textarea { background: #161b22; color: #f0f6fc; resize: vertical; }
  button { background: #9ed0ff; color: #0d1117; cursor: pointer; } button:disabled { opacity: .5; cursor: not-allowed; }
  [role="alert"] { color: #ffb4b4; }
  @media (max-width: 40rem) { main { padding: 1rem; } article, section { padding: 1rem; } }
</style>
