import type { ConnectionMetadata } from './connections.js';
import type { ProbeReport } from './model-probe.js';

export type ConnectionScope = { kind: 'personal' | 'workspace'; id: string };
export interface ConnectionAccess {
  actorUserId: string;
  scope: ConnectionScope;
}
export type ConnectionPermission = 'read' | 'manage' | 'use';
export interface ConnectionAuthority {
  canManage: boolean;
}
export function personalAccess(userId: string): ConnectionAccess {
  return { actorUserId: userId, scope: { kind: 'personal', id: userId } };
}
export function credentialContext(scope: ConnectionScope, id: string): string {
  return scope.kind === 'personal'
    ? `${scope.id}/${id}`
    : `workspace/${scope.id.toLowerCase()}/${id.toLowerCase()}`;
}
export type PublicProbeReport = {
  testedAt: string;
  text: { ok: boolean; code: string };
  action: { ok: boolean; code: string };
};
export function publicProbe(report: ProbeReport): PublicProbeReport {
  return {
    testedAt: report.testedAt,
    text: { ok: report.text.ok, code: report.text.code },
    action: { ok: report.action.ok, code: report.action.code },
  };
}
export interface SharedConnectionView {
  id: string;
  name: string;
  protocol: ConnectionMetadata['protocol'];
  modelId: string;
  availability: 'available' | 'unavailable';
  lastProbe: PublicProbeReport;
  settings?: ConnectionMetadata;
}
export function sharedView(metadata: ConnectionMetadata, canManage: boolean): SharedConnectionView {
  return {
    id: metadata.id,
    name: metadata.name,
    protocol: metadata.protocol,
    modelId: metadata.modelId,
    availability: metadata.enabled ? 'available' : 'unavailable',
    lastProbe: publicProbe(metadata.lastProbe),
    ...(canManage ? { settings: metadata } : {}),
  };
}
