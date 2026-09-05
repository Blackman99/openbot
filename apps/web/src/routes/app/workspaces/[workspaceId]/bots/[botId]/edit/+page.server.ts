import { botVersionAction, loadBotEditPage } from '$lib/server/bot-version-page.js';
import type { Actions, PageServerLoad } from './$types';
export const load: PageServerLoad = (event) =>
  loadBotEditPage(event, event.params.workspaceId, event.params.botId);
export const actions = {
  edit: (event) => botVersionAction(event, event.params.workspaceId, event.params.botId, 'edit'),
} satisfies Actions;
