import { describe, expect, it } from 'vitest';

import { createTelemetry, readTelemetryConfig } from '../../src/telemetry/config.js';

describe('telemetry configuration', () => {
  it('disables telemetry by default and for explicit off values', () => {
    expect(readTelemetryConfig({})).toEqual({ enabled: false });
    expect(readTelemetryConfig({ OPENBOT_TELEMETRY: '' })).toEqual({ enabled: false });
    expect(readTelemetryConfig({ OPENBOT_TELEMETRY: 'false' })).toEqual({ enabled: false });
    expect(readTelemetryConfig({ OPENBOT_TELEMETRY: '0' })).toEqual({ enabled: false });
    expect(readTelemetryConfig({ OPENBOT_TELEMETRY: 'OFF' })).toEqual({ enabled: false });
  });

  it('accepts explicit enablement without registering an exporter', () => {
    expect(readTelemetryConfig({ OPENBOT_TELEMETRY: 'true' })).toEqual({ enabled: true });
    expect(readTelemetryConfig({ OPENBOT_TELEMETRY: '1' })).toEqual({ enabled: true });
    const telemetry = createTelemetry({ enabled: true });
    expect(telemetry.enabled).toBe(true);
    expect(() => telemetry.record('startup')).not.toThrow();
  });

  it('rejects malformed telemetry flags before startup continues', () => {
    expect(() => readTelemetryConfig({ OPENBOT_TELEMETRY: 'maybe' })).toThrow(
      'OPENBOT_TELEMETRY must be true or false',
    );
  });
});
