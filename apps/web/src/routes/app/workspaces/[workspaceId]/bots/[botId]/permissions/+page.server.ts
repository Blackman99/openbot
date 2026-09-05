import { botAclAction, loadBotPermissionsPage } from '$lib/server/bot-acl-page.js';
import type { Actions, PageServerLoad } from './$types';
export const load: PageServerLoad = (event) =>
  loadBotPermissionsPage(event, event.params.workspaceId, event.params.botId);
export const actions = {
  grant: (event) => botAclAction(event, event.params.workspaceId, event.params.botId, 'grant'),
  changeRole: (event) =>
    botAclAction(event, event.params.workspaceId, event.params.botId, 'changeRole'),
  revoke: (event) => botAclAction(event, event.params.workspaceId, event.params.botId, 'revoke'),
  visibility: (event) =>
    botAclAction(event, event.params.workspaceId, event.params.botId, 'visibility'),
} satisfies Actions;
