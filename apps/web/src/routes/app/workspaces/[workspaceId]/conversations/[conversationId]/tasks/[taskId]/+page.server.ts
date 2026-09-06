import {
  loadTaskPage,
  retryTask,
  cancelTask,
  pauseTask,
  resumeTask,
} from '$lib/server/task-page.js';
import type { PageServerLoad, Actions } from './$types';
export const load: PageServerLoad = (event) =>
  loadTaskPage(event, event.params.workspaceId, event.params.conversationId, event.params.taskId);
export const actions: Actions = {
  cancel: (event) =>
    cancelTask(event, event.params.workspaceId, event.params.conversationId, event.params.taskId),
  pause: (event) =>
    pauseTask(event, event.params.workspaceId, event.params.conversationId, event.params.taskId),
  resume: (event) =>
    resumeTask(event, event.params.workspaceId, event.params.conversationId, event.params.taskId),
  retry: (event) =>
    retryTask(event, event.params.workspaceId, event.params.conversationId, event.params.taskId),
};
