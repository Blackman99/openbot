import {
  editRoutineAction,
  loadRoutinePage,
  transitionRoutineAction,
} from '$lib/server/routine-page.js';
import type { Actions, PageServerLoad } from './$types';

export const load: PageServerLoad = (event) =>
  loadRoutinePage(event, event.params.workspaceId, event.params.groupId, event.params.routineId);

export const actions = {
  edit: (event) =>
    editRoutineAction(
      event,
      event.params.workspaceId,
      event.params.groupId,
      event.params.routineId,
    ),
  pause: (event) =>
    transitionRoutineAction(
      event,
      event.params.workspaceId,
      event.params.groupId,
      event.params.routineId,
      'pause',
    ),
  resume: (event) =>
    transitionRoutineAction(
      event,
      event.params.workspaceId,
      event.params.groupId,
      event.params.routineId,
      'resume',
    ),
  cancel: (event) =>
    transitionRoutineAction(
      event,
      event.params.workspaceId,
      event.params.groupId,
      event.params.routineId,
      'cancel',
    ),
} satisfies Actions;
