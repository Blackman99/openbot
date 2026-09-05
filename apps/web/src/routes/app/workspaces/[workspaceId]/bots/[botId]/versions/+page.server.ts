import { loadVersionHistoryPage } from '$lib/server/bot-version-page.js';
import type { PageServerLoad } from './$types';
export const load: PageServerLoad = (event) =>
  loadVersionHistoryPage(event, event.params.workspaceId, event.params.botId);
