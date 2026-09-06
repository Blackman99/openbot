import { loadDeletedBotsPage } from '$lib/server/bot-lifecycle-page.js';
import type { PageServerLoad } from './$types';
export const load: PageServerLoad = (event) => loadDeletedBotsPage(event, event.params.workspaceId);
