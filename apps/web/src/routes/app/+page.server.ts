import { loadWorkspacePage, signOutAction } from '$lib/server/workspace-page.js';
import type { Actions, PageServerLoad } from './$types';

export const load: PageServerLoad = async (event) => loadWorkspacePage(event);

export const actions = { signOut: signOutAction } satisfies Actions;
