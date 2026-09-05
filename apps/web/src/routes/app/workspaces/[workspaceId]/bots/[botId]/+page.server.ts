import { loadBotPage } from '$lib/server/bot-page.js';
import type { PageServerLoad } from './$types';
export const load: PageServerLoad = (event) =>
  loadBotPage(event, event.params.workspaceId, event.params.botId);
