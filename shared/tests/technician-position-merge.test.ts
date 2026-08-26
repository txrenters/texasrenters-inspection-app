import { describe, expect, it } from 'vitest';

import {
  mergeLatestPosition,
  type TechnicianPosition,
} from '../src/contracts/technician-location.js';

function position(overrides: Partial<TechnicianPosition> = {}): TechnicianPosition {
  return {
    id: 'ping-1',
    technicianId: 'tech-a',
    latitude: 29.8665,
    longitude: -95.204,
    accuracyMeters: 8,
    batteryPercent: 74,
    recordedAt: '2026-08-27T10:00:00.000Z',
    technician: { id: 'tech-a', displayName: 'Ernie Saavedra' },
    ...overrides,
  };
}

describe('mergeLatestPosition', () => {
  it('replaces that technician rather than appending', () => {
    // Appending would grow a second marker for the same person on every fix,
    // and the map would become a breadcrumb trail within a minute.
    const merged = mergeLatestPosition(
      [position()],
      position({ id: 'ping-2', latitude: 29.87, recordedAt: '2026-08-27T10:00:30.000Z' }),
    );

    expect(merged).toHaveLength(1);
    expect(merged[0]?.latitude).toBe(29.87);
  });

  it('leaves other technicians alone', () => {
    const other = position({ id: 'ping-b', technicianId: 'tech-b' });
    const merged = mergeLatestPosition(
      [other, position()],
      position({ id: 'ping-2', recordedAt: '2026-08-27T10:00:30.000Z' }),
    );

    expect(merged).toHaveLength(2);
    expect(merged.find((row) => row.technicianId === 'tech-b')).toEqual(other);
  });

  it('adds a technician who was not on the map yet', () => {
    const merged = mergeLatestPosition([position()], position({ technicianId: 'tech-b' }));
    expect(merged).toHaveLength(2);
  });

  it('discards a fix older than the one already held', () => {
    // Batches race: a handset regaining signal can deliver a queued flush just
    // after a live fix. Letting the late one win walks the marker backwards,
    // which reads as the technician driving in reverse.
    const held = position({ recordedAt: '2026-08-27T10:05:00.000Z', latitude: 30 });
    const merged = mergeLatestPosition(
      [held],
      position({ id: 'stale', recordedAt: '2026-08-27T10:00:00.000Z', latitude: 29 }),
    );

    expect(merged[0]?.latitude).toBe(30);
  });

  it('discards a duplicate of the fix already held', () => {
    const held = position();
    const merged = mergeLatestPosition([held], position({ id: 'resent' }));
    expect(merged[0]?.id).toBe(held.id);
  });

  it('does not mutate the list it was given', () => {
    // React Query compares by identity; mutating in place would leave
    // subscribers rendering the previous positions.
    const original = [position()];
    const merged = mergeLatestPosition(original, position({ id: 'ping-2', technicianId: 'tech-b' }));

    expect(original).toHaveLength(1);
    expect(merged).not.toBe(original);
  });
});
