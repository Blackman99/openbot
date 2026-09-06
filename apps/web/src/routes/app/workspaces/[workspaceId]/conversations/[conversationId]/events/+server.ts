import { readConversationStream } from '$lib/server/conversation-stream-api.js';
import type { RequestHandler } from './$types';
export const GET: RequestHandler = readConversationStream;
