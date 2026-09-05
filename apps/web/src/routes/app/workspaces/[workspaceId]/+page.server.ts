import {
  createWorkspaceAction,
  loadWorkspacePage,
  updateWorkspaceAction,
  signOutAction,
} from '$lib/server/workspace-page.js';
import type { Actions, PageServerLoad } from './$types';

export const load: PageServerLoad = (event) => loadWorkspacePage(event, event.params.workspaceId);
export const actions = {
  createWorkspace: createWorkspaceAction,
  updateWorkspace: (event) => updateWorkspaceAction(event, event.params.workspaceId),
  signOut: signOutAction,
} satisfies Actions;
