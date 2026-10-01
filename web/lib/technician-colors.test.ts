import { describe, expect, it } from 'vitest';

import { TECHNICIAN_COLORS, technicianColors } from './technician-colors';

const ids = (count: number) => Array.from({ length: count }, (_, index) => `technician-${index}`);

describe('technicianColors', () => {
  it('gives everybody on one day a different colour', () => {
    const colors = technicianColors(ids(TECHNICIAN_COLORS.length));
    expect(new Set(colors.values()).size).toBe(TECHNICIAN_COLORS.length);
  });

  it('gives the same people the same colours whatever order they arrive in', () => {
    const forward = technicianColors(ids(6));
    const backward = technicianColors(ids(6).reverse());
    expect([...backward.entries()].sort()).toEqual([...forward.entries()].sort());
  });

  it('keeps somebody their colour when other people join the day', () => {
    const alone = technicianColors(['technician-3']).get('technician-3');
    // Both sort after technician-3, which so chooses first and keeps its own.
    const withOthers = technicianColors(['technician-40', 'technician-3', 'technician-41']);
    expect(withOthers.get('technician-3')).toBe(alone);
  });

  it('only ever uses the map palette, and repeats once there are more people than colours', () => {
    const colors = technicianColors(ids(TECHNICIAN_COLORS.length + 3));
    expect(colors.size).toBe(TECHNICIAN_COLORS.length + 3);
    for (const color of colors.values()) expect(TECHNICIAN_COLORS).toContain(color);
  });

  it('counts a repeated id once', () => {
    expect(technicianColors(['a', 'a', 'b']).size).toBe(2);
  });
});
