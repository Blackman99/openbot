import { botVersionAction, loadBotVersionPage } from '$lib/server/bot-version-page.js';
import type { Actions, PageServerLoad } from './$types';
export const load: PageServerLoad = (event) =>
  loadBotVersionPage(event, event.params.workspaceId, event.params.botId, event.params.versionId);
export const actions = {
  restore: (event) =>
    botVersionAction(event, event.params.workspaceId, event.params.botId, 'restore'),
} satisfies Actions;
