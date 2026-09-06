<script lang="ts">
  import CapabilityEditor from '$lib/components/CapabilityEditor.svelte';
  import type { PageProps } from './$types';
  let { data, form }: PageProps = $props();
</script>
<CapabilityEditor {data} {form} />
