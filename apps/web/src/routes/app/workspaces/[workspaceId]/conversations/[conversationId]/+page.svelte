<script lang="ts">
  import RoutingDecision from '$lib/components/RoutingDecision.svelte';
  import { enhance } from '$app/forms';
  import { consumeConversationStream, type ConversationLiveStatus } from '$lib/conversation-stream-client';
  import type { ConversationStreamState } from '$lib/conversation-stream-state';
  import type { MessageProjection } from '$lib/conversation-message';
  import { preparePendingConversationCommand, pendingCommandMatches, type PendingConversationCommand } from '$lib/conversation-pending-command';
  import type { SubmitFunction } from '@sveltejs/kit';
  import type { PageProps } from './$types';
  let { data, form }: PageProps = $props();
  let transportError = $state('');
  let pendingCommand = $state.raw<PendingConversationCommand | null>(null);
  let pendingSending = $state(false);
  let liveMessages = $state.raw<MessageProjection[] | null>(null);
  let liveState = $state.raw<ConversationStreamState | null>(null);
  let liveStatus = $state<ConversationLiveStatus>('stopped');
  let liveNextMessageCursor = $state<string | null | undefined>(undefined);
  let liveCommands = $state<Record<string, { edit: string; tombstone: string; saveMemory: string }>>({});
  let messages = $derived(liveMessages ?? data.messages);
  let nextMessageCursor = $derived(liveNextMessageCursor === undefined ? data.nextCursor : liveNextMessageCursor);
  let visibleExecutions = $derived(Object.values(liveState?.executions ?? {}).filter((run) => run.runStatus === 'queued' || run.runStatus === 'running' || run.runStatus === 'cancelled' || run.runStatus === 'waiting_input' || run.runStatus === 'waiting_approval'));
  let hasCancelledExecutions = $derived(visibleExecutions.some((run) => run.runStatus === 'cancelled'));
  function liveRunLabel(status: string) {
    if (status === 'queued') return 'Queued';
    if (status === 'running') return 'Running';
    if (status === 'cancelled') return 'Cancelled';
    if (status === 'waiting_input') return 'Waiting for input';
    if (status === 'waiting_approval') return 'Waiting for approval';
    return status;
  }
  let previews = $derived(Object.values(liveState?.previews ?? {}));
  let denied = $derived(liveStatus === 'forbidden' || liveStatus === 'authentication-required');
  let base = $derived(`/app/workspaces/${data.workspace.id}/conversations/${data.conversation.id}`);
  $effect(() => {
    const scope = { workspaceId: data.workspace.id, conversationId: data.conversation.id };
    const historical = data.cursor || new URL(window.location.href).searchParams.has('messageId');
    liveMessages = null;
    liveState = null;
    liveCommands = {};
    liveStatus = 'stopped';
    liveNextMessageCursor = undefined;
    if (historical) return;
    const controller = new AbortController();
    void consumeConversationStream({
      scope, request: fetch, signal: controller.signal,
      onStatus(status) { liveStatus = status; if (status === 'forbidden' || status === 'authentication-required') liveMessages = []; },
      onReset(snapshot) { liveMessages = []; liveCommands = {}; liveNextMessageCursor = snapshot.nextMessageCursor; },
      onState(state) { liveState = state; },
      onClearMessage(id) { liveMessages = (liveMessages ?? []).filter((message) => message.id !== id); },
      onMessage(message) {
        const next = [...(liveMessages ?? []).filter((current) => current.id !== message.id), message].sort((a, b) => a.creationSequence - b.creationSequence);
        // Every parsed body is <=32,000 characters (<=128,000 UTF-8 bytes).
        // Keep the full bounded bootstrap page, then cap later live additions.
        while (next.length > 100) next.shift();
        liveMessages = next;
        liveCommands = Object.fromEntries(next.map((current) => [current.id, liveCommands[current.id] ?? { edit: crypto.randomUUID(), tombstone: crypto.randomUUID(), saveMemory: crypto.randomUUID() }]));
      },
    });
    return () => controller.abort();
  });
  function messageCommand(id: string, action: 'edit' | 'tombstone' | 'saveMemory') {
    return data.commands.messages[id]?.[action] ?? liveCommands[id]?.[action] ?? '';
  }
  function matches(action: string, id = '') {
    return form?.action === action && (form.values.messageId ?? '') === id;
  }
  function isPending(action: string, id: string) {
    return pendingCommandMatches(pendingCommand, base, action, id);
  }
  function value(action: string, id: string, field: string, fallback: string) {
    if (isPending(action, id)) return pendingCommand?.values[field] ?? fallback;
    return matches(action, id) ? form?.values[field] ?? fallback : fallback;
  }
  function blocked(action: string, id = '') {
    if ((action === 'saveMemory' || action === 'edit') && pendingCommand && (pendingSending || !isPending(action, id))) return true;
    return matches(action, id) && form?.conflict;
  }
  function actionUrl(action: string) {
    return `?/${action}&limit=${data.limit}${data.cursor ? `&cursor=${encodeURIComponent(data.cursor)}` : ''}`;
  }
  function discardRetry() {
    if (pendingCommand && !pendingSending)
      window.location.assign(`${pendingCommand.scope}?messageId=${pendingCommand.messageId}`);
  }
  const submit: SubmitFunction = ({ action, formData, formElement, cancel }) => {
    const prepared = preparePendingConversationCommand(pendingCommand, base, action, formData);
    if (prepared.status === 'busy' || prepared.status === 'invalid' || (prepared.status === 'ready' && pendingSending)) {
      cancel();
      transportError = prepared.status === 'invalid' ? 'The message form is invalid. Reload the current message before trying again.' : 'Confirm or discard the previous change before starting another.';
      return;
    }
    const command = prepared.status === 'ready' ? prepared.command : null;
    if (command) {
      pendingCommand = command;
      pendingSending = true;
      transportError = '';
    }
    return async ({ result, update }) => {
      if (command === pendingCommand) pendingSending = false;
      if (result.type === 'error') {
        transportError = 'The change could not be confirmed. Retry the unchanged form with the same command key.';
        return;
      }
      transportError = '';
      if (result.type === 'redirect' || result.type === 'success') {
        if (command === pendingCommand) pendingCommand = null;
        if (result.type === 'redirect') formElement.reset();
      }
      await update();
    };
  };
</script>
<svelte:head><title>Conversation history · OpenBot</title></svelte:head>
<main>
  <a href={`/app/workspaces/${data.workspace.id}/conversations`}>Back to conversations</a>
  <h1>{data.conversation.subject.kind === 'group' ? 'Group conversation' : 'Private Bot conversation'}</h1>
  {#if data.conversation.subject.kind === 'direct-bot'}<p>This history is private to its human creator.</p><p>Bot ID: {data.conversation.subject.id}</p>
  {#if data.conversation.botLifecycleState === 'deleted'}<p>Deleted Bot · Historical identity retained</p>{:else if data.conversation.botLifecycleState === 'archived'}<p>Archived Bot · New work blocked</p>{/if}{/if}
  <nav aria-label="Message pages">
    <a href={`${base}/tasks`}>Tasks</a>
    <a href={`${base}/memory-candidates`}>Memory review inbox</a>
    {#if data.conversation.subject.kind === 'group'}<a href={`/app/workspaces/${data.workspace.id}/groups/${data.conversation.subject.id}/memories`}>Group memories</a>{/if}
    {#if data.conversation.subject.kind === 'group'}<a href={`/app/workspaces/${data.workspace.id}/groups/${data.conversation.subject.id}/routing`}>Routing settings</a>{/if}
    <a href={`${base}?limit=${data.limit}`}>Refresh messages</a>
    {#if nextMessageCursor}<a href={`${base}?cursor=${encodeURIComponent(nextMessageCursor)}&limit=${data.limit}`}>Next page</a>{/if}
  </nav>
  {#if form && 'message' in form && form.message}<p role="status">{form.message}</p>{/if}
  {#if transportError || form?.error}<p role="alert">{transportError || form?.error}</p>{/if}
  {#if data.selectedRouting}
    <section id={`routing-${data.selectedRouting.task.id}`} aria-label="Selected Task routing">
      <h2>Why this Bot was selected</h2>
      <a href={`${base}/tasks/${data.selectedRouting.task.id}`}>Open saved task</a>
      <RoutingDecision decision={data.selectedRouting.decision} />
    </section>
  {/if}
  {#if pendingCommand && !pendingSending}
    <p>The previous request may already have completed. Discarding this retry does not undo it.</p>
    <button type="button" onclick={discardRetry}>Discard retry and reload</button>
  {/if}
  {#if liveStatus === 'live'}<p role="status">Live updates connected</p>
  {:else if liveStatus === 'connecting' || liveStatus === 'reconnecting'}<p role="status">Connecting live updates…</p>
  {:else if liveStatus === 'forbidden'}<p role="alert">You no longer have permission to read this conversation.</p>
  {:else if liveStatus === 'authentication-required'}<p role="alert">Sign in again to read this conversation.</p>
  {:else if liveStatus === 'unavailable'}<p role="status">Live updates are unavailable. Refresh messages to try again.</p>{/if}
  {#each messages as message (message.id)}
    <article id={`message-${message.id}`} aria-label={`Message by ${message.author.displayName}`}>
      <h2>{message.author.displayName}</h2>
      {#if 'kind' in message.author}<p>Bot · configuration version {message.author.versionNumber}</p>{/if}
      <p>Version {message.version} · <time datetime={message.createdAt}>{message.createdAt}</time></p>
      {#if message.deleted}<p><strong>Deleted message</strong> · {message.reason}</p>{:else}<pre>{message.body}</pre>{/if}
      {#if message.attachment}<p><a href={`${base}/messages/${message.id}/attachment`}>Download {message.attachment.filename}</a> · {message.attachment.bytes.toLocaleString()} bytes</p>{/if}
      {#if message.canAudit && message.attachment}<details><summary>Permanently purge message and files</summary><p>This permanently deletes message content, its attachment, and registered derived files. Cleanup retries if storage is temporarily unavailable.</p><form method="POST" action={actionUrl('purge')} use:enhance={submit}><input type="hidden" name="messageId" value={message.id}/><button>Permanently purge</button></form></details>{/if}
      {#if message.canAudit}<a href={`${base}/messages/${message.id}/versions`}>View versions</a>{/if}
      {#if data.conversation.subject.kind === 'group' && !message.deleted && message.body?.trim()}
        <details open={matches('saveMemory', message.id) || isPending('saveMemory', message.id)}>
          <summary>Save as group memory</summary>
          <p>This keeps a reference to this version. Editing, deleting or purging its source makes the memory unavailable.</p>
          <form method="POST" action={actionUrl('saveMemory')} use:enhance={submit}>
            <input type="hidden" name="groupId" value={data.conversation.subject.id} />
            <input type="hidden" name="messageId" value={message.id} />
            <input type="hidden" name="expectedSourceEventId" value={value('saveMemory', message.id, 'expectedSourceEventId', message.versionEventId)} />
            <input type="hidden" name="idempotencyKey" value={value('saveMemory', message.id, 'idempotencyKey', messageCommand(message.id, 'saveMemory'))} />
            <label for={`memory-confidence-${message.id}`}>Confidence (your estimate, 0–1)</label>
            <input id={`memory-confidence-${message.id}`} type="number" name="confidence" min="0" max="1" step="any" required readonly={isPending('saveMemory', message.id)} value={value('saveMemory', message.id, 'confidence', '0.5')} />
            <button disabled={blocked('saveMemory', message.id)}>Save group memory</button>
          </form>
        </details>
      {/if}
      {#if message.canEdit}
        <details open={matches('edit', message.id) || isPending('edit', message.id)}>
          <summary>Edit message</summary>
          <form method="POST" action={actionUrl('edit')} use:enhance={submit}>
            <input type="hidden" name="messageId" value={message.id} />
            <input type="hidden" name="idempotencyKey" value={value('edit', message.id, 'idempotencyKey', messageCommand(message.id, 'edit'))} />
            <input type="hidden" name="expectedVersion" value={value('edit', message.id, 'expectedVersion', String(message.version))} />
            <label for={`edit-${message.id}`}>Edit message text</label>
            <textarea id={`edit-${message.id}`} name="body" rows="4" maxlength="32000" required readonly={isPending('edit', message.id)} value={value('edit', message.id, 'body', message.body ?? '')}></textarea>
            <button disabled={blocked('edit', message.id)}>Save edit</button>
          </form>
        </details>
      {/if}
      {#if message.canDelete}
        <details open={matches('tombstone', message.id)}>
          <summary>Delete message</summary>
          <form method="POST" action={actionUrl('tombstone')} use:enhance={submit}>
            <input type="hidden" name="messageId" value={message.id} />
            <input type="hidden" name="idempotencyKey" value={value('tombstone', message.id, 'idempotencyKey', messageCommand(message.id, 'tombstone'))} />
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
  {#if visibleExecutions.length || previews.length}
    <section aria-label="Live task progress">
      <h2>Task progress</h2>
      {#each visibleExecutions as run (run.runId)}<p><a href={`${base}/tasks/${run.taskId}`}>{run.bot.displayName}</a> · {liveRunLabel(run.runStatus)}</p>{/each}
      {#each previews as preview (preview.runId)}
        {@const execution = liveState?.executions[preview.runId]}
        <div aria-label={execution?.runStatus === 'cancelled' ? 'Interrupted output' : 'Draft answer'}>
          {#if execution?.runStatus === 'cancelled'}<p><a href={`${base}/tasks/${preview.taskId}`}>{execution.bot.displayName}</a></p>{/if}
          {#if preview.status === 'unavailable'}
            {#if execution?.runStatus === 'cancelled'}<p>Cancelled · Read any saved interrupted output in task details.</p>{:else}<p>Preview unavailable; awaiting final answer.</p>{/if}
          {:else if preview.status === 'interrupted'}<p>Interrupted output · Cancelled before completion</p><pre>{preview.text}</pre>
          {:else}<p>Draft answer · Still running</p><pre>{preview.text}</pre>{/if}
        </div>
      {/each}
      {#if liveState?.previewsTruncated}
        {#if hasCancelledExecutions}<p>Some previews are unavailable. Check task details for saved interrupted output; completed answers appear in conversation history.</p>
        {:else}<p>Some previews are unavailable. Final answers appear in conversation history.</p>{/if}
      {/if}
    </section>
  {/if}
  {#if data.canWrite && !denied}
    <section aria-labelledby="write-heading">
      <h2 id="write-heading">Add a message</h2>
      <form method="POST" action={actionUrl('append')} enctype="multipart/form-data" use:enhance={submit}>
        <input type="hidden" name="idempotencyKey" value={value('append', '', 'idempotencyKey', data.commands.append)} />
        <label for="new-message">Message</label>
        <textarea id="new-message" name="body" rows="5" maxlength="32000" required value={value('append', '', 'body', '')}></textarea>
        <label for="message-attachment">Attachment (optional)</label><input id="message-attachment" name="attachment" type="file" accept=".txt,.md,.csv,.png,.jpg,.jpeg,.pdf,.docx,.xlsx"/><p>Text, Markdown, CSV, PNG, JPEG, PDF, DOCX or XLSX, up to {(data.attachmentMaximum / 1048576).toLocaleString()} MiB. Files stay in this conversation.</p>
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
