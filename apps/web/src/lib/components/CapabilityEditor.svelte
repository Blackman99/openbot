<script lang="ts">
  import { capabilityFlags, type CapabilityFlag, type RequiredCapability } from '../capability-types.js';
  import type { CapabilityPageData } from '../server/capability-page.js';
  let { data, form }: { data: CapabilityPageData; form?: { error?: string; success?: string; reloadRequired?: boolean } | null } = $props();
  const flagNames: Record<CapabilityFlag, string> = { text: 'Text', streaming: 'Streaming', toolCalling: 'Tool calling', structuredOutput: 'Structured output', visionInput: 'Vision input' };
  const requirementNames: Record<RequiredCapability, string> = { basic: 'Basic', collaboration: 'Collaboration', visionInput: 'Vision input' };
  const protocolNames = { 'openai-chat': 'OpenAI Chat Completions', 'openai-responses': 'OpenAI Responses', 'anthropic-messages': 'Anthropic Messages' };
  const reasons = { disabled: 'Disabled', capability_unknown: 'Capability unknown', capability_unsupported: 'Capability unsupported', not_accessible: 'Not accessible' };
  let draft = $state<{ id: string; revision: number; ids: string[] } | null>(null);
  let fallbackIds = $derived(draft?.id === data.catalog.id && draft.revision === data.catalog.revision ? draft.ids : data.catalog.fallbacks.connectionIds);
  function setFallbacks(ids: string[]) { draft = { id: data.catalog.id, revision: data.catalog.revision, ids }; }
  function move(index: number, direction: number) {
    const ids = [...fallbackIds];
    const target = index + direction;
    const current = ids[index];
    const other = ids[target];
    if (current === undefined || other === undefined) return;
    ids[index] = other; ids[target] = current; setFallbacks(ids);
  }
</script>
<svelte:head><title>Capabilities · {data.catalog.name} · OpenBot</title></svelte:head>
<main>
  <a href={data.backHref}>← {data.workspaceId ? 'Workspace models' : 'Personal models'}</a>
  <h1>{data.catalog.name} capabilities</h1>
  <p>{data.catalog.modelId} · {protocolNames[data.catalog.protocol]} · {data.catalog.enabled ? 'Enabled' : 'Unavailable (disabled)'}</p>
  {#if form?.error}<p role="alert">{form.error}</p>{/if}
  {#if form?.reloadRequired}<p><a href="?">Reload capabilities</a></p>{/if}
  {#if form?.success}<p role="status">{form.success}</p>{/if}
  <section aria-labelledby="capability-summary">
    <h2 id="capability-summary">Capability catalog</h2>
    <div class="summary">
      <article><h3>{data.catalog.basic ? data.catalog.collaboration ? 'Basic' : 'Basic · chat-only' : 'Basic: unavailable'}</h3><p>Requires supported text and streaming.</p></article>
      <article><h3>Collaboration: {data.catalog.collaboration ? 'available' : 'unavailable'}</h3><p>Requires Basic and reliable tool calling or structured output.</p></article>
      <article><h3>Enhanced</h3><p>Vision input: {data.catalog.flags.visionInput.status}</p><p>Vision requests also require Basic.</p></article>
    </div>
    <p>Last probed: {#if data.catalog.lastProbedAt}<time datetime={data.catalog.lastProbedAt}>{data.catalog.lastProbedAt}</time>{:else}Not yet verified{/if}</p>
    <p>Optional features stay unknown until evidence or an authorized manual override establishes support.</p>
    <div class="evidence">
      {#each capabilityFlags as flag}
        {@const evidence = data.catalog.flags[flag]}
        <article aria-labelledby={`flag-${flag}`}>
          <h3 id={`flag-${flag}`}>{flagNames[flag]}: {evidence.status}</h3>
          <p>Source: {evidence.source} · Evidence: {evidence.evidence}</p>
          <p>Actor: {evidence.actorUserId ?? 'No evidence yet'} · Observed: {evidence.observedAt ?? 'Not observed'} · Last probed: {evidence.lastProbedAt ?? 'Not probed'}</p>
          {#if evidence.manualBadge && evidence.override}
            <p class="badge">Manual override · {evidence.override.active ? 'Active' : 'Stale — target changed'}</p>
            <p>{evidence.override.value ? 'Supported' : 'Unsupported'}: {evidence.override.rationale}</p>
            <p>Override actor: {evidence.override.actorUserId} · Recorded: <time datetime={evidence.override.createdAt}>{evidence.override.createdAt}</time> · Target generation: {evidence.override.generation}</p>
            {#if !evidence.override.active}<p>This earlier override does not grant support to the current target.</p>{/if}
          {/if}
        </article>
      {/each}
    </div>
  </section>
  {#if data.catalog.canManage}
    <section aria-labelledby="manage-heading">
      <h2 id="manage-heading">Manage evidence</h2>
      <p>Re-probing records fresh evidence and retains manual overrides. Active overrides take precedence over probes.</p>
      <form method="POST" action="?/reprobe">
        <input type="hidden" name="expectedRevision" value={data.catalog.revision} />
        <button disabled={!data.catalog.enabled || form?.reloadRequired}>Re-probe capabilities</button>
      </form>
      <form method="POST" action="?/override">
        <fieldset disabled={form?.reloadRequired}>
          <legend>Manual override</legend>
          <input type="hidden" name="expectedRevision" value={data.catalog.revision} />
          <label>Capability<select name="capability">{#each capabilityFlags as flag}<option value={flag}>{flagNames[flag]}</option>{/each}</select></label>
          <label>Support decision<select name="value"><option value="true">Supported</option><option value="false">Unsupported</option></select></label>
          <label>Rationale<textarea name="rationale" required maxlength="500" rows="3"></textarea></label>
          <p>Explain the evidence for this decision. The rationale, actor, and time remain visible with a manual badge.</p>
          <button>Save manual override</button>
        </fieldset>
      </form>
    </section>
  {/if}
  <section aria-labelledby="fallback-heading">
    <h2 id="fallback-heading">Ordered fallbacks</h2>
    <p>{data.workspaceId ? 'Fallbacks must stay in the same workspace. Personal connections and other workspaces cannot be used.' : 'Fallbacks must belong to your personal connections. Workspace connections cannot be used.'}</p>
    <p>Required capability: {requirementNames[data.catalog.fallbacks.requiredCapability]}</p>
    {#if data.catalog.fallbacks.connectionIds.length}
      <ol aria-label="Saved fallback order">{#each data.catalog.fallbacks.connectionIds as id}<li>{data.choices.find((choice) => choice.id === id)?.name ?? 'Unavailable model'} · {id}</li>{/each}</ol>
    {:else}<p>No fallbacks configured.</p>{/if}
    {#if data.catalog.canManage}
      <form method="POST" action="?/fallbacks">
        <fieldset disabled={form?.reloadRequired}>
          <legend>Edit fallback order</legend>
          <input type="hidden" name="expectedRevision" value={data.catalog.revision} />
          <label>Required capability<select name="requiredCapability" value={data.catalog.fallbacks.requiredCapability}>
            <option value="basic">Basic</option><option value="collaboration">Collaboration</option><option value="visionInput">Vision input</option>
          </select></label>
          <ol aria-label="Fallback editor">
            {#each fallbackIds as id, index}
              <li>
                <label>Fallback priority {index + 1}<select name="connectionIds" value={id} required onchange={(event) => setFallbacks(fallbackIds.map((value, position) => position === index ? event.currentTarget.value : value))}>
                  <option value="">Choose an enabled model</option>
                  {#if id && !data.choices.some((choice) => choice.id === id)}<option value={id}>Unavailable model · {id}</option>{/if}
                  {#each data.choices.filter((choice) => choice.id !== data.catalog.id) as choice}
                    <option value={choice.id} disabled={!choice.enabled && choice.id !== id}>{choice.name}{choice.enabled ? '' : ' (disabled)'}</option>
                  {/each}
                </select></label>
                <div class="controls">
                  <button type="button" disabled={index === 0} onclick={() => move(index, -1)}>Move up</button>
                  <button type="button" disabled={index === fallbackIds.length - 1} onclick={() => move(index, 1)}>Move down</button>
                  <button type="button" onclick={() => setFallbacks(fallbackIds.filter((_, position) => position !== index))}>Remove fallback</button>
                </div>
              </li>
            {/each}
          </ol>
          <div class="controls">
            <button type="button" disabled={fallbackIds.length >= 16 || fallbackIds.includes('') || !data.choices.some((choice) => choice.enabled && choice.id !== data.catalog.id && !fallbackIds.includes(choice.id))} onclick={() => setFallbacks([...fallbackIds, ''])}>Add fallback</button>
            <button>Save fallback order</button>
          </div>
          <p>Up to 16 distinct models. Each must meet the required capability; cycles and unavailable models are rejected.</p>
        </fieldset>
      </form>
    {/if}
  </section>
  <section aria-labelledby="preview-heading">
    <h2 id="preview-heading">Resolution preview</h2>
    <p>Checks the primary and each fallback in configured order, including their descendants once. No provider request, retry, or model switch occurs.</p>
    <form method="GET" class="preview-form">
      <label>Requested capability<select name="capability" value={data.preview.requiredCapability}>
        <option value="basic">Basic</option><option value="collaboration">Collaboration</option><option value="visionInput">Vision input</option>
      </select></label><button>Preview resolution</button>
    </form>
    <p>Selected model: {data.preview.selectedId ? (data.preview.candidates.find((candidate) => candidate.id === data.preview.selectedId)?.name ?? data.preview.selectedId) : 'None available'}</p>
    <ol aria-label="Resolution candidates">
      {#each data.preview.candidates as candidate}
        <li><strong>{candidate.name ?? candidate.id}</strong>{candidate.id === data.catalog.id ? ' · Primary' : ' · Fallback'}
          <p>{candidate.eligible ? `Eligible · priority ${data.preview.order.indexOf(candidate.id) + 1}` : `Excluded · ${candidate.reason ? reasons[candidate.reason] : ''}`}{candidate.id === data.preview.selectedId ? ' · Selected' : ''}</p>
          {#if candidate.modelId && candidate.protocol}<p>{candidate.modelId} · {protocolNames[candidate.protocol]}</p>{/if}
        </li>
      {/each}
    </ol>
  </section>
</main>
<style>
  :global(body) { margin:0;background:#0d1117;color:#f0f6fc;font-family:Inter,ui-sans-serif,system-ui,sans-serif; }
  main { max-width:68rem;margin:auto;padding:2rem 1rem; }
  a { color:#7ee787; }
  p,li { line-height:1.6;overflow-wrap:anywhere; }
  section { border:1px solid #30363d;border-radius:.75rem;margin-top:1.5rem;padding:1.5rem; }
  .summary { display:grid;grid-template-columns:repeat(auto-fit,minmax(15rem,1fr));gap:1rem; }
  article { background:#161b22;padding:1rem;border-radius:.5rem; }
  .evidence { display:grid;gap:.7rem; }
  h3 { margin-top:0; }
  label { display:grid;gap:.4rem;margin:.8rem 0; }
  input,textarea,select,button { box-sizing:border-box;border:1px solid #8b949e;border-radius:.4rem;background:#161b22;color:inherit;font:inherit;padding:.7rem; }
  input,textarea,select { width:100%;min-width:0; }
  button { cursor:pointer; }
  button:disabled { opacity:.5;cursor:default; }
  fieldset { border:1px solid #30363d;border-radius:.5rem;margin-top:1rem;padding:1rem;min-width:0; }
  .controls { display:flex;flex-wrap:wrap;gap:.6rem; }
  .preview-form { max-width:28rem; }
  ol { padding-left:1.5rem; }
  li { margin:.75rem 0; }
  .badge { display:inline-block;background:#49380a;color:#ffd27d;padding:.2rem .5rem;border-radius:.3rem;margin-bottom:0; }
  [role="alert"] { color:#ffa198; }
  [role="status"] { color:#7ee787; }
</style>
