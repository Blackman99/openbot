import {
  loadMemoriesPage,
  retainMemoryAction,
  revokeMemoryAction,
  searchMemoryAction,
} from '$lib/server/memory-page.js';
import type { Actions, PageServerLoad } from './$types';
export const load: PageServerLoad = (event) =>
  loadMemoriesPage(event, event.params.workspaceId, event.params.groupId);
export const actions = {
  search: (event) => searchMemoryAction(event, event.params.workspaceId, event.params.groupId),
  retainMemory: (event) =>
    retainMemoryAction(event, event.params.workspaceId, event.params.groupId),
  revokeMemory: (event) =>
    revokeMemoryAction(event, event.params.workspaceId, event.params.groupId),
} satisfies Actions;
