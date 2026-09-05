import { loadMemoriesPage, searchMemoryAction } from '$lib/server/memory-page.js';
import type { Actions, PageServerLoad } from './$types';
export const load: PageServerLoad = (event) =>
  loadMemoriesPage(event, event.params.workspaceId, event.params.groupId);
export const actions = {
  search: (event) => searchMemoryAction(event, event.params.workspaceId, event.params.groupId),
} satisfies Actions;
