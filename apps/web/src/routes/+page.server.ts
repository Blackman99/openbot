import type { PageServerLoad } from './$types';

import { fetchStatus, type PageStatus } from '$lib/server/status.js';

type StatusLoadEvent = Pick<Parameters<PageServerLoad>[0], 'fetch'>;

export async function load({ fetch }: StatusLoadEvent): Promise<PageStatus> {
  const apiBaseUrl = process.env.API_BASE_URL ?? 'http://localhost:3001';
  return fetchStatus(fetch, apiBaseUrl);
}
