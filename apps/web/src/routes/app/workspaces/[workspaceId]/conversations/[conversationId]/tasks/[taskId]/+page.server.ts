import { loadTaskPage } from '$lib/server/task-page.js';
import type { PageServerLoad } from './$types';
export const load: PageServerLoad = (event) =>
  loadTaskPage(event, event.params.workspaceId, event.params.conversationId, event.params.taskId);
