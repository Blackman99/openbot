import { botCopyAction, loadBotCopyPage } from '$lib/server/bot-copy-page.js';
import type { Actions, PageServerLoad } from './$types';
export const load: PageServerLoad = (event) =>
  loadBotCopyPage(event, event.params.workspaceId, event.params.botId);
export const actions: Actions = {
  confirm: (event) => botCopyAction(event, event.params.workspaceId, event.params.botId),
};
