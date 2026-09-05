import {
  createInvitationAction,
  loadInvitationsPage,
  revokeInvitationAction,
} from '$lib/server/invitation-page.js';
import type { Actions, PageServerLoad } from './$types';
export const load: PageServerLoad = (event) => loadInvitationsPage(event, event.params.workspaceId);
export const actions = {
  create: (event) => createInvitationAction(event, event.params.workspaceId),
  revoke: (event) => revokeInvitationAction(event, event.params.workspaceId),
} satisfies Actions;
