<script lang="ts">
  import { enhance } from '$app/forms';
  import type { SubmitFunction } from '@sveltejs/kit';
  let { canResume, canConfirm, idempotencyKey, expectedRunId, actionUrl, action }: {
    canResume: boolean; canConfirm: boolean; idempotencyKey: string; expectedRunId: string;
    actionUrl: string; action?: { values: Record<string,string>; uncertain: boolean; conflict: boolean; error: string };
  } = $props();
  let submitting=$state(false), transportError=$state('');
  let unconfirmed=$state<Record<string,string>|null>(null);
  let values=$derived(unconfirmed??action?.values??{});
  let uncertain=$derived(Boolean(unconfirmed)||Boolean(action?.uncertain));
  let confirm=$derived(canConfirm&&uncertain&&Boolean(values.idempotencyKey&&values.expectedRunId));
  const resumeTask:SubmitFunction=({formData,cancel})=>{
    if(submitting){cancel();return;}
    const captured:Record<string,string>={};
    for(const key of ['idempotencyKey','expectedRunId']){const value=formData.get(key);if(typeof value==='string')captured[key]=value;}
    submitting=true;transportError='';
    return async({result,update})=>{
      const preserve=()=>{unconfirmed=captured;transportError='The resume could not be confirmed. Confirm the unchanged command to check whether its attempt was created.';};
      try{if(result.type==='error'){preserve();return;}await update({reset:false,invalidateAll:false});unconfirmed=null;}
      catch{preserve();}finally{submitting=false;}
    };
  };
</script>
{#if transportError || action?.error}<p role="alert">{transportError || action?.error}</p>{/if}
{#if canResume || confirm}
  <section aria-labelledby="resume-heading">
    <h2 id="resume-heading">Resume task</h2>
    <p>Creates one new attempt from the original task input. The paused run, its checkpoint, and any interrupted output stay available.</p>
    <form method="POST" action={actionUrl} use:enhance={resumeTask}>
      <input type="hidden" name="idempotencyKey" value={values.idempotencyKey??idempotencyKey} />
      <input type="hidden" name="expectedRunId" value={values.expectedRunId??expectedRunId} />
      {#if uncertain}<p>The original resume command is preserved until its outcome is confirmed.</p>{/if}
      <button disabled={submitting||action?.conflict}>{submitting?'Confirming…':uncertain?'Confirm unchanged resume':'Resume paused task'}</button>
    </form>
  </section>
{/if}
<style>
  section { margin-top: 1.5rem; } h2 { font-size: 1.25rem; }
  button { padding:.75rem; border:1px solid #526171; border-radius:.4rem; font:inherit; background:#9ed0ff; color:#0d1117; cursor:pointer; }
  button:disabled { opacity:.5; cursor:not-allowed; } [role="alert"] { color:#ffb4b4; }
</style>
