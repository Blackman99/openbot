import { loadTaskPage, retryTask } from '$lib/server/task-page.js';
import type { PageServerLoad, Actions } from './$types';
export const load: PageServerLoad = (event) =>
  loadTaskPage(event, event.params.workspaceId, event.params.conversationId, event.params.taskId);
export const actions: Actions = {
  retry: (event) =>
    retryTask(event, event.params.workspaceId, event.params.conversationId, event.params.taskId),
};
