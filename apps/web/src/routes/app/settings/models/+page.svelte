<script lang="ts">
  import type { PersonalConnection } from '$lib/server/provider-api.js';
  let { data,form }: {data:{connections:PersonalConnection[]};form?:{error?:string;success?:string}|null} = $props();
  const protocolNames = { 'openai-chat': 'OpenAI Chat Completions', 'openai-responses': 'OpenAI Responses', 'anthropic-messages': 'Anthropic Messages' };
  let selectedProtocols = $state<Record<string, string>>({});
</script>

<svelte:head><title>Personal models · OpenBot</title></svelte:head>

{#snippet fields(connection:PersonalConnection|undefined)}
  {@const key = connection?.id ?? 'new'}
  {@const protocol = selectedProtocols[key] ?? connection?.protocol ?? 'openai-chat'}
  {#if connection}<input type="hidden" name="id" value={connection.id} />{/if}
  <label>Name<input name="name" required maxlength="120" value={connection?.name ?? ''} /></label>
  <label>Protocol<select name="protocol" value={protocol} onchange={(event) => selectedProtocols[key] = event.currentTarget.value}>
    <option value="openai-chat">OpenAI Chat Completions</option>
    <option value="openai-responses">OpenAI Responses</option>
    <option value="anthropic-messages">Anthropic Messages</option>
  </select></label>
  <label>Anthropic version<input name="anthropicVersion" disabled={protocol !== 'anthropic-messages'} maxlength="10" pattern={'[0-9]{4}-[0-9]{2}-[0-9]{2}'} value={connection?.anthropicVersion ?? '2023-06-01'} /><small>Used only for Anthropic Messages.</small></label>
  <label>Base URL<input name="baseUrl" type="url" required placeholder="https://api.openai.com/v1" value={connection?.baseUrl ?? ''} /></label>
  <label>Model ID<input name="modelId" required maxlength="256" value={connection?.modelId ?? ''} /></label>
  <label>API key<input name="apiKey" type="password" autocomplete="new-password" maxlength="4096" placeholder={connection ? 'Leave empty to keep saved key' : 'Optional for unauthenticated endpoints'} /></label>
  {#if connection}<label class="inline"><input name="clearApiKey" type="checkbox" /> Clear saved API key</label>{/if}
  <label>Custom headers (JSON)<textarea name="headers" rows="3" placeholder={connection ? 'Leave empty to keep saved headers; {} removes all' : '{"x-api-key":"your key"}'}></textarea></label>
  <button type="submit">Test and save</button>
{/snippet}

<main>
  <a href="/app">← Workspace</a>
  <h1>Personal models</h1>
  <p>Connect an OpenAI Chat Completions, Responses, or Anthropic Messages-compatible model. Only you can use or manage these connections.</p>
  {#if form?.error}<p role="alert">{form.error}</p>{/if}
  {#if form?.success}<p role="status">{form.success}</p>{/if}
  <section aria-labelledby="new-model">
    <h2 id="new-model">Add a model</h2>
    <p>Saving first tests live text streaming and structured actions. A model with working text can be saved even if structured actions are unavailable.</p>
    <form method="POST" action="?/save">{@render fields(undefined)}</form>
  </section>
  {#each data.connections as connection (connection.id)}
    <article aria-labelledby={`model-${connection.id}`}>
      <h2 id={`model-${connection.id}`}>{connection.name}</h2>
      <p><a href={`/app/settings/models/${encodeURIComponent(connection.id)}/capabilities`}>Capabilities and fallbacks</a></p>
      <p>{connection.enabled ? 'Enabled' : 'Disabled'} · {connection.modelId} · {protocolNames[connection.protocol]}</p>
      <p>API key: {connection.apiKeyConfigured ? 'configured' : 'not configured'}</p>
      <p>Configured headers: {connection.headerNames.join(', ') || 'none'}</p>
      <p>Text stream: {connection.lastProbe.text.ok ? 'passed' : 'failed'} · Structured actions: {connection.lastProbe.action.ok ? 'passed' : 'unavailable'}</p>
      <p>Last tested: <time datetime={connection.lastProbe.testedAt}>{connection.lastProbe.testedAt}</time></p>
      <details><summary>Test evidence</summary><pre>{JSON.stringify(connection.lastProbe,null,2)}</pre></details>
      <details><summary>Edit connection</summary><form method="POST" action="?/save">{@render fields(connection)}</form></details>
      <div class="controls">
        <form method="POST" action="?/test"><input type="hidden" name="id" value={connection.id} /><button disabled={!connection.enabled}>Test again</button></form>
        <form method="POST" action="?/disable"><input type="hidden" name="id" value={connection.id} /><button disabled={!connection.enabled}>Disable</button></form>
        <form method="POST" action="?/delete"><input type="hidden" name="id" value={connection.id} /><button>Delete</button></form>
      </div>
    </article>
  {/each}
</main>

<style>
  :global(body) { margin:0;background:#0d1117;color:#f0f6fc;font-family:Inter,ui-sans-serif,system-ui,sans-serif; }
  main { margin:auto;max-width:58rem;padding:2rem 1rem; }
  a { color:#7ee787; }
  section,article { border:1px solid #30363d;border-radius:.75rem;margin-top:1.5rem;padding:1.5rem; }
  p { line-height:1.6;overflow-wrap:anywhere; }
  label { display:grid;gap:.4rem;margin:1rem 0; }
  label.inline { display:flex;align-items:center; }
  input,textarea,select,button { box-sizing:border-box;border:1px solid #8b949e;border-radius:.4rem;background:#161b22;color:inherit;font:inherit;padding:.7rem; }
  input,textarea,select { width:100%;min-width:0; }
  input[type="checkbox"] { width:auto; }
  button { cursor:pointer; }
  button:disabled { opacity:.5;cursor:default; }
  .controls { display:flex;flex-wrap:wrap;gap:.7rem;margin-top:1rem; }
  details { margin:1rem 0; }
  summary { cursor:pointer; }
  pre { white-space:pre-wrap;overflow-wrap:anywhere;max-height:24rem;overflow:auto;font-size:.85rem; }
  [role="alert"] { color:#ffa198; }
  [role="status"] { color:#7ee787; }
</style>
