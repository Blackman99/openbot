import {
  createApiTokenAction,
  loadApiTokensPage,
  revokeApiTokenAction,
} from '$lib/server/api-token-page.js';
import type { Actions, PageServerLoad } from './$types';
export const load: PageServerLoad = (event) => loadApiTokensPage(event, event.params.workspaceId);
export const actions = {
  create: (event) => createApiTokenAction(event, event.params.workspaceId),
  revoke: (event) => revokeApiTokenAction(event, event.params.workspaceId),
} satisfies Actions;
