import { loadSecurityPage, unlinkOidcAction } from '$lib/server/oidc-security-page.js';
import { signOutAction } from '$lib/server/workspace-page.js';
import type { Actions, PageServerLoad } from './$types';

export const load: PageServerLoad = loadSecurityPage;
export const actions = { unlink: unlinkOidcAction, signOut: signOutAction } satisfies Actions;
