import {
  approveCandidateAction,
  confirmCandidateAction,
  editCandidateAction,
  loadCandidatesPage,
  previewCandidateAction,
  rejectCandidateAction,
} from '$lib/server/candidate-page.js';
import type { Actions, PageServerLoad } from './$types';

export const load: PageServerLoad = (event) =>
  loadCandidatesPage(event, event.params.workspaceId, event.params.conversationId);

export const actions = {
  editCandidate: (event) =>
    editCandidateAction(event, event.params.workspaceId, event.params.conversationId),
  rejectCandidate: (event) =>
    rejectCandidateAction(event, event.params.workspaceId, event.params.conversationId),
  approveCandidate: (event) =>
    approveCandidateAction(event, event.params.workspaceId, event.params.conversationId),
  previewCandidate: (event) =>
    previewCandidateAction(event, event.params.workspaceId, event.params.conversationId),
  confirmCandidate: (event) =>
    confirmCandidateAction(event, event.params.workspaceId, event.params.conversationId),
} satisfies Actions;
