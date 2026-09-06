import { error, redirect } from '@sveltejs/kit';
import { createAuthApiClient } from '$lib/server/auth-api.js';
import { createBotApiClient } from '$lib/server/bot-api.js';
import { createMemoryApiClient } from '$lib/server/memory-api.js';
import { createWorkspaceApiClient } from '$lib/server/workspace-api.js';
import { isConversationUuid } from '$lib/server/conversation-api.js';
import {
  clearSessionCookie,
  preventAuthenticationCaching,
  readSessionCookie,
} from '$lib/server/session-cookie.js';
import type { PageServerLoad } from './$types';
export const load: PageServerLoad = async (event) => {
  preventAuthenticationCaching(event.setHeaders);
  const { workspaceId, botId } = event.params;
  if (!isConversationUuid(workspaceId) || !isConversationUuid(botId))
    error(400, 'Invalid private memory request');
  const session = readSessionCookie(event.cookies);
  const identity = await createAuthApiClient(event.fetch).getIdentity(session);
  if (identity.status !== 'authenticated') {
    clearSessionCookie(event.cookies);
    redirect(303, '/sign-in');
  }
  const workspaces = await createWorkspaceApiClient(event.fetch).list(session);
  if (workspaces.status !== 'available') error(503, 'Memories unavailable');
  const workspace = workspaces.value.find((item) => item.id === workspaceId.toLowerCase());
  if (!workspace) error(403, 'This Bot is not available with your current access.');
  const bot = await createBotApiClient(event.fetch).get(session, workspaceId, botId);
  if (bot.status !== 'available') error(403, 'This Bot is not available with your current access.');
  const page = await createMemoryApiClient(event.fetch).listPrivate(session, workspaceId, botId);
  if (page.status === 'forbidden')
    error(403, 'This Bot is not available with your current access.');
  if (page.status !== 'available') error(503, 'Memories unavailable');
  return {
    user: identity.identity.user,
    workspace,
    workspaces: workspaces.value,
    bot: bot.value,
    memories: page.value.memories,
  };
};
