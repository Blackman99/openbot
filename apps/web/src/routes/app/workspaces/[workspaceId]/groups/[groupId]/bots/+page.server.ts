import { groupBotAction, loadGroupBotsPage } from '$lib/server/group-bot-page.js';
import type { Actions, PageServerLoad } from './$types';
export const load: PageServerLoad = (event) =>
  loadGroupBotsPage(event, event.params.workspaceId, event.params.groupId);
export const actions = {
  invite: (event) =>
    groupBotAction(event, event.params.workspaceId, event.params.groupId, 'invite'),
  remove: (event) =>
    groupBotAction(event, event.params.workspaceId, event.params.groupId, 'remove'),
} satisfies Actions;
