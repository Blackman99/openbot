import { error, fail, redirect } from '@sveltejs/kit';

import { createAuthApiClient } from '$lib/server/auth-api.js';
import {
  preventAuthenticationCaching,
  readSessionCookie,
  storeSessionCookie,
} from '$lib/server/session-cookie.js';

import type { Actions, PageServerLoad } from './$types';

export const load: PageServerLoad = async ({ cookies, fetch, setHeaders }) => {
  preventAuthenticationCaching(setHeaders);
  const auth = createAuthApiClient(fetch);
  const state = await auth.getClaimState();
  if (state.status === 'unavailable') {
    error(503, 'Authentication service unavailable');
  }
  if (!state.claimed) {
    redirect(303, '/setup');
  }

  const identity = await auth.getIdentity(readSessionCookie(cookies));
  if (identity.status === 'authenticated') {
    redirect(303, '/app');
  }
  if (identity.status === 'unavailable') {
    error(503, 'Authentication service unavailable');
  }

  return {};
};

export const actions = {
  default: async ({ cookies, fetch, request, setHeaders }) => {
    preventAuthenticationCaching(setHeaders);
    const form = await request.formData();
    const email = form.get('email');
    const password = form.get('password');
    if (typeof email !== 'string' || typeof password !== 'string') {
      return fail(400, { error: 'Enter your email and password.' });
    }

    const result = await createAuthApiClient(fetch).signIn({ email, password });
    if (result.status === 'authenticated') {
      storeSessionCookie(cookies, result.cookie);
      redirect(303, '/app');
    }
    if (result.status === 'invalid-credentials') {
      return fail(400, { email, error: 'Email or password is incorrect.' });
    }
    if (result.status === 'invalid-request') {
      return fail(400, { email, error: 'Enter a valid email and password.' });
    }
    if (result.status === 'rate-limited') {
      const retryHint =
        result.retryAfterSeconds === undefined
          ? 'Try again shortly.'
          : `Try again in ${result.retryAfterSeconds} seconds.`;
      if (result.retryAfterSeconds !== undefined) {
        setHeaders({ 'retry-after': String(result.retryAfterSeconds) });
      }
      return fail(429, { email, error: `Too many sign-in attempts. ${retryHint}` });
    }

    error(503, 'Authentication service unavailable');
  },
} satisfies Actions;
