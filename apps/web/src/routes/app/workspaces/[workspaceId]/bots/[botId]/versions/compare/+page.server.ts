import { loadVersionComparisonPage } from '$lib/server/bot-version-page.js';
import type { PageServerLoad } from './$types';
export const load: PageServerLoad = (event) =>
  loadVersionComparisonPage(event, event.params.workspaceId, event.params.botId);
