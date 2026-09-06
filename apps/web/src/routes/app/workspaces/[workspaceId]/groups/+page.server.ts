import { createGroupAction, loadGroupsPage } from '$lib/server/group-page.js';
import type { Actions, PageServerLoad } from './$types';
export const load: PageServerLoad = (event) => loadGroupsPage(event, event.params.workspaceId);
export const actions = {
  create: (event) => createGroupAction(event, event.params.workspaceId),
} satisfies Actions;
