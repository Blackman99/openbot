import {
  confirmPromotionAction,
  editMemoryAction,
  forgetMemoryAction,
  loadMemoryPage,
  previewPromotionAction,
} from '$lib/server/memory-page.js';
import type { Actions, PageServerLoad } from './$types';
export const load: PageServerLoad = (event) =>
  loadMemoryPage(event, event.params.workspaceId, event.params.groupId, event.params.memoryId);
export const actions: Actions = {
  editMemory: (event) =>
    editMemoryAction(event, event.params.workspaceId, event.params.groupId, event.params.memoryId),
  forgetMemory: (event) =>
    forgetMemoryAction(
      event,
      event.params.workspaceId,
      event.params.groupId,
      event.params.memoryId,
    ),
  previewPromotion: (event) =>
    previewPromotionAction(
      event,
      event.params.workspaceId,
      event.params.groupId,
      event.params.memoryId,
    ),
  confirmPromotion: (event) =>
    confirmPromotionAction(
      event,
      event.params.workspaceId,
      event.params.groupId,
      event.params.memoryId,
    ),
};
