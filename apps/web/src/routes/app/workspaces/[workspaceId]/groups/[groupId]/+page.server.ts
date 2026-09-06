import {
  addGroupMemberAction,
  changeGroupMemberRoleAction,
  loadGroupPage,
  removeGroupMemberAction,
  updateGroupAction,
} from '$lib/server/group-page.js';
import type { Actions, PageServerLoad } from './$types';
export const load: PageServerLoad = (event) =>
  loadGroupPage(event, event.params.workspaceId, event.params.groupId);
export const actions = {
  update: (event) => updateGroupAction(event, event.params.workspaceId, event.params.groupId),
  add: (event) => addGroupMemberAction(event, event.params.workspaceId, event.params.groupId),
  changeRole: (event) =>
    changeGroupMemberRoleAction(event, event.params.workspaceId, event.params.groupId),
  remove: (event) => removeGroupMemberAction(event, event.params.workspaceId, event.params.groupId),
} satisfies Actions;
