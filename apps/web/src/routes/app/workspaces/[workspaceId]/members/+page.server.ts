import {
  changeMemberRoleAction,
  loadMembersPage,
  removeMemberAction,
} from '$lib/server/member-page.js';
import type { Actions, PageServerLoad } from './$types';
export const load: PageServerLoad = (event) => loadMembersPage(event, event.params.workspaceId);
export const actions = {
  changeRole: (event) => changeMemberRoleAction(event, event.params.workspaceId),
  remove: (event) => removeMemberAction(event, event.params.workspaceId),
} satisfies Actions;
