import { loadGroupRoutingPage, updateGroupRouting } from '$lib/server/group-routing-page.js';
import type { Actions, PageServerLoad } from './$types';
export const load: PageServerLoad = (event) =>
  loadGroupRoutingPage(event, event.params.workspaceId, event.params.groupId);
export const actions = {
  update: (event) => updateGroupRouting(event, event.params.workspaceId, event.params.groupId),
} satisfies Actions;
