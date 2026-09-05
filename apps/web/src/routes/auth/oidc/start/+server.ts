import { startOidc } from '$lib/server/oidc-flow.js';
import type { RequestHandler } from './$types';

export const POST: RequestHandler = startOidc;
