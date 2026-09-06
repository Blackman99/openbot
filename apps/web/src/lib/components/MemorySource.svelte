<script lang="ts">
  import type { Memory } from '$lib/server/memory-api.js';
  let { memory }: { memory: Memory } = $props();
  const sourceUrl = $derived(`/app/workspaces/${memory.scope.workspaceId}/conversations/${memory.source.conversationId}?messageId=${memory.source.messageId}#message-${memory.source.messageId}`);
</script>
<article aria-label="Saved memory">
  <pre>{memory.text}</pre>
  <p>Memory version {memory.version} · Confidence {memory.confidence} (human estimate)</p>
  <p>Saved by {memory.creator.displayName} · <time datetime={memory.createdAt}>{memory.createdAt}</time></p>
  <p><a href={sourceUrl}>View current source message</a> · Message version {memory.source.version} · {memory.source.author.displayName}{#if 'kind' in memory.source.author} (Bot configuration version {memory.source.author.versionNumber}){/if}</p>
  <details><summary>Source provenance</summary><dl>
    <dt>Memory version ID</dt><dd>{memory.versionId}</dd>
    <dt>Source event ID</dt><dd>{memory.source.eventId}</dd>
    <dt>Original creation event ID</dt><dd>{memory.source.creationEventId}</dd>
    <dt>Original creation sequence</dt><dd>{memory.source.creationSequence}</dd>
    <dt>Source created</dt><dd>{memory.source.createdAt}</dd>
    <dt>Source updated</dt><dd>{memory.source.updatedAt}</dd>
    <dt>Group ID</dt><dd>{memory.scope.groupId}</dd>
  </dl></details>
</article>
<style>
  article { border: 1px solid #30363d; border-radius: .75rem; padding: 1.25rem; margin: 1rem 0; overflow-wrap: anywhere; }
  pre { white-space: pre-wrap; font: inherit; }
  a { color: #a5d6ff; } summary { cursor: pointer; } dt { font-weight: bold; margin-top: .75rem; } dd { margin-left: 0; }
</style>
