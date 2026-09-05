import { createBotAction, loadBotsPage } from '$lib/server/bot-page.js';
import type { Actions, PageServerLoad } from './$types';
export const load: PageServerLoad = (event) => loadBotsPage(event, event.params.workspaceId);
export const actions = {
  create: (event) => createBotAction(event, event.params.workspaceId),
} satisfies Actions;
