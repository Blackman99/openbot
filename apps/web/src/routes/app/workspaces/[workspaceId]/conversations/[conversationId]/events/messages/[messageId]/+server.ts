import { readConversationStreamMessage } from '$lib/server/conversation-stream-api.js';
import type { RequestHandler } from './$types';
export const GET: RequestHandler = readConversationStreamMessage;
