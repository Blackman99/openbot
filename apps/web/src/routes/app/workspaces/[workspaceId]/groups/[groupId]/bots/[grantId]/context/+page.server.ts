import { loadGroupBotContextPage } from '$lib/server/group-bot-page.js';
import type { PageServerLoad } from './$types';
export const load: PageServerLoad = (event) =>
  loadGroupBotContextPage(
    event,
    event.params.workspaceId,
    event.params.groupId,
    event.params.grantId,
  );
