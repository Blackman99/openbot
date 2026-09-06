import { readAvatar } from '$lib/server/avatar-page.js';
import type { RequestHandler } from './$types';
export const GET: RequestHandler = readAvatar;
export const HEAD: RequestHandler = readAvatar;
