import { purgeMessageAction } from '$lib/server/attachment-page.js';
import { saveMemoryAction } from '$lib/server/memory-page.js';
import { conversationAction, loadConversationPage } from '$lib/server/conversation-page.js';
import type { Actions, PageServerLoad } from './$types';
export const load: PageServerLoad = (event) =>
  loadConversationPage(event, event.params.workspaceId, event.params.conversationId);
export const actions = {
  saveMemory: (event) =>
    saveMemoryAction(event, event.params.workspaceId, event.params.conversationId),
  purge: (event) => purgeMessageAction(event),
  append: (event) =>
    conversationAction(event, event.params.workspaceId, event.params.conversationId, 'append'),
  edit: (event) =>
    conversationAction(event, event.params.workspaceId, event.params.conversationId, 'edit'),
  tombstone: (event) =>
    conversationAction(event, event.params.workspaceId, event.params.conversationId, 'tombstone'),
} satisfies Actions;
