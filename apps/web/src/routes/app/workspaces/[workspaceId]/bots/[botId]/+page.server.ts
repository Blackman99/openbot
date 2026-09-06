import { loadBotPage } from '$lib/server/bot-page.js';
import { uploadAvatarAction, removeAvatarAction } from '$lib/server/avatar-page.js';
import type { Actions, PageServerLoad } from './$types';
export const actions = {
  uploadAvatar: uploadAvatarAction,
  removeAvatar: removeAvatarAction,
} satisfies Actions;
export const load: PageServerLoad = (event) =>
  loadBotPage(event, event.params.workspaceId, event.params.botId);
