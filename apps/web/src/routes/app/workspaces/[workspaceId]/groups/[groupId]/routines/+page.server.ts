import { createRoutineAction, loadRoutinesPage } from '$lib/server/routine-page.js';
import type { Actions, PageServerLoad } from './$types';

export const load: PageServerLoad = (event) =>
  loadRoutinesPage(event, event.params.workspaceId, event.params.groupId);

export const actions = {
  create: (event) => createRoutineAction(event, event.params.workspaceId, event.params.groupId),
} satisfies Actions;
