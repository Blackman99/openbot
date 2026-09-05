import {
  acceptInvitationAction,
  loadJoinPage,
  signInForInvitationAction,
} from '$lib/server/invitation-page.js';
import type { Actions, PageServerLoad } from './$types';
export const load: PageServerLoad = loadJoinPage;
export const actions = {
  accept: acceptInvitationAction,
  signIn: signInForInvitationAction,
} satisfies Actions;
