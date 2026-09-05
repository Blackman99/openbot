export interface PageStatus {
  status: 'ready' | 'unavailable';
}

const STATUS_REQUEST_TIMEOUT_MS = 2_000;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}

function isReadyStatusPayload(value: unknown): boolean {
  if (!isRecord(value) || !isRecord(value.checks)) {
    return false;
  }

  return (
    value.schemaVersion === 1 &&
    value.status === 'ready' &&
    value.checks.database === 'ready' &&
    value.checks.migrations === 'current'
  );
}

export async function fetchStatus(
  request: typeof globalThis.fetch,
  apiBaseUrl: string,
): Promise<PageStatus> {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), STATUS_REQUEST_TIMEOUT_MS);

  try {
    const response = await request(`${apiBaseUrl.replace(/\/$/, '')}/api/v1/status`, {
      signal: controller.signal,
    });

    if (!response.ok) {
      return { status: 'unavailable' };
    }

    const payload: unknown = await response.json();

    return { status: isReadyStatusPayload(payload) ? 'ready' : 'unavailable' };
  } catch {
    return { status: 'unavailable' };
  } finally {
    clearTimeout(timeout);
  }
}
