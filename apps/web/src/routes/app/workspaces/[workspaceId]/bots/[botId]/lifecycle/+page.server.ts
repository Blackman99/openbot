import { botLifecycleAction, loadBotLifecyclePage } from '$lib/server/bot-lifecycle-page.js';
import type { Actions, PageServerLoad } from './$types';
export const load: PageServerLoad = (event) =>
  loadBotLifecyclePage(event, event.params.workspaceId, event.params.botId);
export const actions = {
  archive: (event) =>
    botLifecycleAction(event, event.params.workspaceId, event.params.botId, 'archive'),
  restore: (event) =>
    botLifecycleAction(event, event.params.workspaceId, event.params.botId, 'restore'),
  delete: (event) =>
    botLifecycleAction(event, event.params.workspaceId, event.params.botId, 'delete'),
  undoDelete: (event) =>
    botLifecycleAction(event, event.params.workspaceId, event.params.botId, 'undo-delete'),
} satisfies Actions;
