export interface ReadinessChecks {
  database: 'ready' | 'unavailable';
  migrations: 'current' | 'stale' | 'unknown';
}

export interface ReadinessProbe {
  check(): Promise<ReadinessChecks>;
}
