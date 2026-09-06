import { readAttachment } from '$lib/server/attachment-page.js';
import type { RequestHandler } from './$types';
export const GET: RequestHandler = (event) => readAttachment(event);
export const HEAD: RequestHandler = (event) => readAttachment(event);
