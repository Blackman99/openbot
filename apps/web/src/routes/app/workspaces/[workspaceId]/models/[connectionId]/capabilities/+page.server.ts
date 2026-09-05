import { capabilityAction, loadCapabilitiesPage } from '$lib/server/capability-page.js';
import type { Actions, PageServerLoad } from './$types';
export const load: PageServerLoad = (event) =>
  loadCapabilitiesPage(event, event.params.connectionId, event.params.workspaceId);
export const actions = {
  override: (event) =>
    capabilityAction(event, event.params.connectionId, 'override', event.params.workspaceId),
  fallbacks: (event) =>
    capabilityAction(event, event.params.connectionId, 'fallbacks', event.params.workspaceId),
  reprobe: (event) =>
    capabilityAction(event, event.params.connectionId, 'reprobe', event.params.workspaceId),
} satisfies Actions;
