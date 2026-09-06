import { downloadTeamTemplate } from '$lib/server/team-template-page.js';
import type { RequestHandler } from './$types';

export const GET: RequestHandler = ({ cookies, fetch, setHeaders, params }) =>
  downloadTeamTemplate({ cookies, fetch, setHeaders }, params.workspaceId, params.groupId);
