export const CLAIM_LEASE_MS = 15_000;
export const CLAIM_HEARTBEAT_MS = 1_000;
export const RECOVERY_CANDIDATE_LIMIT = 10;

export function leaseExpiry(now: Date, deadlineAt: Date): Date {
  return new Date(Math.min(now.getTime() + CLAIM_LEASE_MS, deadlineAt.getTime()));
}
