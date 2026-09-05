<script lang="ts">
  import type { RoutingDecision } from '../routing-contract.js';
  let { decision }: { decision: RoutingDecision } = $props();
  const reasons = {
    mention: 'Explicit @ mention',
    default: 'Group default',
    'local-match': 'Local term match',
  } as const;
</script>
<section aria-label="Routing decision">
  <h3>Lead: {decision.lead.name}</h3>
  <p>{decision.lead.roleDescription}</p>
  <p>Selected by: <strong>{reasons[decision.reason]}</strong></p>
  <details>
    <summary>Candidate evidence ({decision.candidates.length})</summary>
    <p>Scores measure matches to public persona terms, not a confidence percentage. Equal scores use stable Bot identity order. Mentions and eligible defaults take precedence.</p>
    {#each decision.candidates as candidate (candidate.grantId)}
      <article>
        <h4>{candidate.name}{#if candidate.grantId === decision.lead.grantId} · Selected Lead{/if}</h4>
        <p>{candidate.roleDescription}</p>
        {#if candidate.description}<p>{candidate.description}</p>{/if}
        <p>Lexical score: {candidate.score}</p>
        {#if candidate.matchedTerms.length}
          <p>Matched terms: {candidate.matchedTerms.join(', ')}</p>
        {:else}<p>No matching terms</p>{/if}
      </article>
    {/each}
    <p>These personas and memberships were saved when the task was submitted.</p>
  </details>
</section>
<style>
  section { overflow-wrap: anywhere; }
  details { border: 1px solid #526171; border-radius: .5rem; padding: 1rem; }
  summary { cursor: pointer; }
  article { border-top: 1px solid #526171; margin-top: 1rem; padding-top: .5rem; }
  h4 { margin-bottom: .5rem; }
</style>
