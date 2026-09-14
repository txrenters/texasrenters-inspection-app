import { describe, expect, it } from 'vitest';

import { isOnTheDay } from './technician-roster';

/**
 * Who belongs on the map for the day being looked at.
 *
 * Work that day decides it, not whether the phone is reporting. The screenshot that prompted this showed the
 * map centred on Oroquieta City: it fits itself to every marker, and one
 * offline office tester with nothing scheduled had a last position in the
 * Philippines, which dragged the whole view away from every Texas stop.
 */

const NOW = Date.parse('2026-09-14T15:00:00.000Z');
const minutesAgo = (m: number) => new Date(NOW - m * 60_000).toISOString();

const entry = (over: { stops?: number; reportedMinutesAgo?: number | null }) =>
  ({
    technicianId: 't',
    displayName: 'Someone',
    stops: Array.from({ length: over.stops ?? 0 }, (_, i) => ({ inspectionId: `i${i}` })),
    position:
      over.reportedMinutesAgo === null || over.reportedMinutesAgo === undefined
        ? null
        : { recordedAt: minutesAgo(over.reportedMinutesAgo) },
  }) as never;

describe('whether a technician is on the day', () => {
  it('hides somebody online with nothing scheduled', () => {
    // Scheduled work decides it, not the phone. This is the office tester in
    // the Philippines whose marker dragged the map across the Pacific.
    expect(isOnTheDay(entry({ stops: 0, reportedMinutesAgo: 2 }))).toBe(false);
  });

  it('shows somebody with stops even though they are offline', () => {
    /**
     * Moses at eight in the morning: eleven stops, phone not yet reporting.
     * Exactly who a dispatcher is looking for, and hiding him because he has
     * not started would hide the day's work.
     */
    expect(isOnTheDay(entry({ stops: 11, reportedMinutesAgo: 3 * 24 * 60 }))).toBe(true);
  });

  it('shows somebody with stops who has never reported at all', () => {
    expect(isOnTheDay(entry({ stops: 2, reportedMinutesAgo: null }))).toBe(true);
  });

  it('hides somebody offline with nothing scheduled', () => {
    // The Oroquieta City marker.
    expect(isOnTheDay(entry({ stops: 0, reportedMinutesAgo: 3 * 24 * 60 }))).toBe(false);
  });

  it('hides somebody who has never reported and has nothing scheduled', () => {
    expect(isOnTheDay(entry({ stops: 0, reportedMinutesAgo: null }))).toBe(false);
  });
});
