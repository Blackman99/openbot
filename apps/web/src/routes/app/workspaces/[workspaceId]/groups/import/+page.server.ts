import { loadTeamImportPage, teamImportAction } from '$lib/server/team-template-page.js';
import type { Actions, PageServerLoad } from './$types';

export const load: PageServerLoad = ({ cookies, fetch, setHeaders, params }) =>
  loadTeamImportPage({ cookies, fetch, setHeaders }, params.workspaceId);

export const actions: Actions = {
  default: ({ cookies, fetch, request, setHeaders, params }) =>
    teamImportAction({ cookies, fetch, request, setHeaders }, params.workspaceId),
};
