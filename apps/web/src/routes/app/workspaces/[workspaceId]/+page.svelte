<script lang="ts">
  import WorkspacePage from '../../+page.svelte';
  import type { PageProps } from './$types';
  let { data, form }: PageProps = $props();
</script>

<WorkspacePage {data} {form} />
