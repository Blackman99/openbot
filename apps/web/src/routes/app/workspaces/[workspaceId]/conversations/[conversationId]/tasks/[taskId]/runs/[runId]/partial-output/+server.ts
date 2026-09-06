import { readTaskPartialOutput } from '$lib/server/task-partial-output.js';
import type { RequestHandler } from './$types';
export const GET: RequestHandler = readTaskPartialOutput;
