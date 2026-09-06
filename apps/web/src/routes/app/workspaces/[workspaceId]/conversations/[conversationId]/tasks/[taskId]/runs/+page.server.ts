import { loadTaskRunsPage } from '$lib/server/task-page.js';
import type { PageServerLoad } from './$types';
export const load: PageServerLoad = (event) =>
  loadTaskRunsPage(
    event,
    event.params.workspaceId,
    event.params.conversationId,
    event.params.taskId,
  );
