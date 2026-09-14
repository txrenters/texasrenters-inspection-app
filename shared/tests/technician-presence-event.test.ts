import { describe, expect, it } from 'vitest';

import {
  applyPresenceEvent,
  type TechnicianPosition,
} from '../src/contracts/technician-location.js';

function position(technicianId: string, app: TechnicianPosition['app']): TechnicianPosition {
  return {
    id: `ping-${technicianId}`,
    technicianId,
    latitude: 29.8665,
    longitude: -95.3021,
    accuracyMeters: 12,
    batteryPercent: null,
    headingDegrees: null,
    speedMetersPerSecond: null,
    recordedAt: '2026-09-15T14:00:00.000Z',
    technician: { id: technicianId, displayName: technicianId },
    app,
  };
}

describe('a technician app opening or closing', () => {
  it('changes whether that technician is online, and nothing else', () => {
    const moses = position('moses', { connected: false, lastSeenAt: '2026-09-15T13:00:00.000Z' });
    const other = position('other', { connected: true, lastSeenAt: null });

    const next = applyPresenceEvent([moses, other], {
      technicianId: 'moses',
      connected: true,
      lastSeenAt: '2026-09-15T15:00:00.000Z',
    });

    expect(next[0]).toEqual({
      ...moses,
      app: { connected: true, lastSeenAt: '2026-09-15T15:00:00.000Z' },
    });
    expect(next[1]).toBe(other);
  });

  it('leaves the list as it is for a technician it does not hold', () => {
    // No position yet: the next fetch brings the whole row, presence included.
    const positions = [position('moses', null)];
    expect(
      applyPresenceEvent(positions, { technicianId: 'someone-else', connected: true, lastSeenAt: null }),
    ).toBe(positions);
  });
});
