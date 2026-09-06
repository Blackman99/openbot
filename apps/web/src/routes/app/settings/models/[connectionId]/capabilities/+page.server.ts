import { capabilityAction, loadCapabilitiesPage } from '$lib/server/capability-page.js';
import type { Actions, PageServerLoad } from './$types';
export const load: PageServerLoad = (event) =>
  loadCapabilitiesPage(event, event.params.connectionId);
export const actions = {
  override: (event) => capabilityAction(event, event.params.connectionId, 'override'),
  fallbacks: (event) => capabilityAction(event, event.params.connectionId, 'fallbacks'),
  reprobe: (event) => capabilityAction(event, event.params.connectionId, 'reprobe'),
} satisfies Actions;
