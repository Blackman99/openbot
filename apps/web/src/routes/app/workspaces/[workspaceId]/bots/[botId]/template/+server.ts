import { downloadBotTemplate } from '$lib/server/bot-template-page.js';
import type { RequestHandler } from './$types';

export const GET: RequestHandler = ({ cookies, fetch, setHeaders, params }) =>
  downloadBotTemplate({ cookies, fetch, setHeaders }, params.workspaceId, params.botId);
