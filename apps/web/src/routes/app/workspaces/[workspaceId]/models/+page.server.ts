import {
  disableWorkspaceModelAction,
  loadWorkspaceModelsPage,
  priceWorkspaceModelAction,
  saveWorkspaceModelAction,
  testWorkspaceModelAction,
} from '$lib/server/workspace-provider-page.js';
import type { Actions, PageServerLoad } from './$types';

export const load: PageServerLoad = (event) =>
  loadWorkspaceModelsPage(event, event.params.workspaceId);
export const actions = {
  save: (event) => saveWorkspaceModelAction(event, event.params.workspaceId),
  disable: (event) => disableWorkspaceModelAction(event, event.params.workspaceId),
  test: (event) => testWorkspaceModelAction(event, event.params.workspaceId),
  price: (event) => priceWorkspaceModelAction(event, event.params.workspaceId),
} satisfies Actions;
