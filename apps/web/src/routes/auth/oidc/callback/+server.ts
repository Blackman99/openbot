import { completeOidc } from '$lib/server/oidc-flow.js';
import type { RequestHandler } from './$types';

export const GET: RequestHandler = completeOidc;
