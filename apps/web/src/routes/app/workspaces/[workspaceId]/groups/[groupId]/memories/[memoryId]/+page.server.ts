import { loadMemoryPage } from '$lib/server/memory-page.js';
import type { PageServerLoad } from './$types';
export const load: PageServerLoad = (event) =>
  loadMemoryPage(event, event.params.workspaceId, event.params.groupId, event.params.memoryId);
