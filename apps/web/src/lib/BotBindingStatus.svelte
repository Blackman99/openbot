<script lang="ts">
  import type { BindingStatus } from './server/bot-api.js';
  let { status }: { status: BindingStatus } = $props();
  const messages = {
    disabled: 'This model is disabled. Review its settings or select an enabled model when rebinding is available.',
    'binding-changed': 'The connection now uses a different model. This Bot keeps its original binding.',
    'capability-unavailable': 'Text and streaming capabilities need verification. Review the model capabilities.',
    'not-accessible': 'The bound model is not available with your current access.',
  };
</script>
{#if status.state === 'ready'}
  <p class="capability">{status.chatOnly ? 'Chat-only — unsuitable for reliable delegation' : 'Collaboration-capable'}</p>
{:else}
  <p class="unavailable">Model unavailable. {messages[status.reason]}</p>
{/if}
<style>
  .capability { color: #b1e4c0; }
  .unavailable { color: #ffd79a; }
</style>
