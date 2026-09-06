import { loadTasksPage, submitTask } from '$lib/server/task-page.js';
import type { Actions, PageServerLoad } from './$types';
export const load: PageServerLoad = (event) => {
  event.depends(`openbot:tasks:${event.params.conversationId}`);
  return loadTasksPage(event, event.params.workspaceId, event.params.conversationId);
};
export const actions = {
  default: (event) => submitTask(event, event.params.workspaceId, event.params.conversationId),
} satisfies Actions;
