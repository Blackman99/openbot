import { botImportAction, loadBotImportPage } from '$lib/server/bot-template-page.js';
import type { Actions, PageServerLoad } from './$types';

export const load: PageServerLoad = ({ cookies, fetch, setHeaders, params }) =>
  loadBotImportPage({ cookies, fetch, setHeaders }, params.workspaceId);

export const actions: Actions = {
  default: ({ cookies, fetch, request, setHeaders, params }) =>
    botImportAction({ cookies, fetch, request, setHeaders }, params.workspaceId),
};
