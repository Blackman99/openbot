import { error, fail, redirect } from '@sveltejs/kit';

import { createAuthApiClient } from '$lib/server/auth-api.js';
import { readSessionCookie, storeSessionCookie } from '$lib/server/session-cookie.js';

import type { Actions, PageServerLoad } from './$types';

export const load: PageServerLoad = async ({ cookies, fetch }) => {
  const auth = createAuthApiClient(fetch);
  const state = await auth.getClaimState();
  if (state.status === 'unavailable') {
    error(503, 'Authentication service unavailable');
  }
  if (!state.claimed) {
    return {};
  }

  const identity = await auth.getIdentity(readSessionCookie(cookies));
  redirect(303, identity.status === 'authenticated' ? '/app' : '/sign-in');
};

export const actions = {
  default: async ({ cookies, fetch, request }) => {
    const form = await request.formData();
    const displayName = form.get('displayName');
    const email = form.get('email');
    const password = form.get('password');
    const setupToken = form.get('setupToken');
    if (
      typeof displayName !== 'string' ||
      typeof email !== 'string' ||
      typeof password !== 'string' ||
      typeof setupToken !== 'string'
    ) {
      return fail(400, { error: 'Enter a display name, email, password, and setup token.' });
    }

    const result = await createAuthApiClient(fetch).setup({
      displayName,
      email,
      password,
      setupToken,
    });
    if (result.status === 'authenticated') {
      storeSessionCookie(cookies, result.cookie);
      redirect(303, '/app');
    }
    if (result.status === 'already-claimed') {
      redirect(303, '/sign-in');
    }
    if (result.status === 'invalid-request') {
      return fail(400, {
        displayName,
        email,
        error: 'Use a valid name and email, and a password of at least 12 characters.',
      });
    }
    if (result.status === 'invalid-setup-token') {
      return fail(403, { displayName, email, error: 'Setup token is incorrect.' });
    }

    error(503, 'Authentication service unavailable');
  },
} satisfies Actions;
