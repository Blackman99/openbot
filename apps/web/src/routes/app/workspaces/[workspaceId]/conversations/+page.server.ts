import { conversationAction, loadConversationsPage } from '$lib/server/conversation-page.js';
import type { Actions, PageServerLoad } from './$types';
export const load: PageServerLoad = (event) =>
  loadConversationsPage(event, event.params.workspaceId);
export const actions = {
  open: (event) => conversationAction(event, event.params.workspaceId, undefined, 'open'),
} satisfies Actions;
