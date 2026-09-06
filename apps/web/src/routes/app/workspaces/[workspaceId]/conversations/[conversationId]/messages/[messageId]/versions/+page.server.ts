import { loadMessageVersionsPage } from '$lib/server/conversation-page.js';
import type { PageServerLoad } from './$types';
export const load: PageServerLoad = (event) =>
  loadMessageVersionsPage(
    event,
    event.params.workspaceId,
    event.params.conversationId,
    event.params.messageId,
  );
