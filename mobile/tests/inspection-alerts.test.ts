import type { Inspection } from '../src/domain/models';
import { formatDueIn, formatOverdueFor } from '../src/components/InspectionUrgencyBadge';
import {
  collectInspectionAlerts,
  inspectionUrgency,
} from '../src/utils/inspection-alerts';

const NOW = new Date('2026-07-31T09:00:00Z').getTime();
const MINUTE = 60_000;
const HOUR = 60 * MINUTE;

/** A date-only scheduledAt, the shape the DATE column now serialises to. */
function onDay(offsetDays: number): string {
  const day = new Date(Date.UTC(2026, 6, 31 + offsetDays));
  return day.toISOString();
}

function inspection(overrides: Partial<Inspection> = {}): Inspection {
  return {
    id: 'insp-1',
    externalInspectionId: 'EXT-1',
    propertyId: 'prop-1',
    type: 'MOVE_OUT',
    scheduledAt: new Date(NOW + HOUR).toISOString(),
    assignedUserId: 'user-1',
    status: 'SCHEDULED',
    priority: 'STANDARD',
    roomIds: [],
    propertyNotes: '',
    property: { id: 'prop-1', address: '1 Main St', cityStateZip: 'Austin, TX', imageTone: 'teal' },
    progress: { completed: 0, total: 4, hasFailedUpload: false },
    ...overrides,
  } as Inspection;
}

describe('inspectionUrgency', () => {
  it('marks a scheduled inspection overdue once its day has passed', () => {
    // The reported bug: a past-scheduled inspection showed no indicator at all.
    const past = inspection({ scheduledAt: onDay(-1) });
    expect(inspectionUrgency(past, NOW)).toBe('overdue');
  });

  it('treats today as due and a future day as merely scheduled', () => {
    const soon = inspection({ scheduledAt: onDay(0) });
    const later = inspection({ scheduledAt: onDay(2) });
    expect(inspectionUrgency(soon, NOW)).toBe('due_soon');
    expect(inspectionUrgency(later, NOW)).toBe('scheduled');
  });

  it('stays quiet about work started a few hours after its slot', () => {
    // Running over by an afternoon is ordinary; a technician who begins at 9:05
    // for a 9:00 slot should not be told they are late.
    for (const status of ['IN_PROGRESS', 'COMPLETED', 'CANCELLED'] as const) {
      const started = inspection({
        status,
        scheduledAt: onDay(0),
      });
      expect(inspectionUrgency(started, NOW)).toBeNull();
    }
  });

  it('flags an in-progress inspection left open past its scheduled day', () => {
    // The case that showed no indicator at all: started, never finished, and
    // still sitting there days later.
    const stale = inspection({
      status: 'IN_PROGRESS',
      scheduledAt: onDay(-8),
    });
    expect(inspectionUrgency(stale, NOW)).toBe('overdue');
  });

  it('never nags about started work inside the one-day grace', () => {
    // Counted in whole days now: yesterday's work is still in hand, the day
    // before that is not.
    const justInside = inspection({ status: 'IN_PROGRESS', scheduledAt: onDay(-1) });
    const justOutside = inspection({ status: 'IN_PROGRESS', scheduledAt: onDay(-2) });
    expect(inspectionUrgency(justInside, NOW)).toBeNull();
    expect(inspectionUrgency(justOutside, NOW)).toBe('overdue');
  });

  it('never warns about finished or cancelled work, however old', () => {
    for (const status of ['COMPLETED', 'CANCELLED', 'TECHNICIAN_SUBMITTED'] as const) {
      const ancient = inspection({
        status,
        scheduledAt: new Date(NOW - 30 * 24 * HOUR).toISOString(),
      });
      expect(inspectionUrgency(ancient, NOW)).toBeNull();
    }
  });

  it('an in-progress inspection is never "due soon"', () => {
    // It has already started; counting down to its start time is nonsense.
    const upcoming = inspection({
      status: 'IN_PROGRESS',
      scheduledAt: new Date(NOW + MINUTE).toISOString(),
    });
    expect(inspectionUrgency(upcoming, NOW)).toBeNull();
  });

  it('ignores an unparseable schedule instead of reporting it overdue', () => {
    const broken = inspection({ scheduledAt: 'not-a-date' });
    expect(inspectionUrgency(broken, NOW)).toBeNull();
  });
});

describe('collectInspectionAlerts', () => {
  it('separates overdue from due-soon and counts both', () => {
    const alerts = collectInspectionAlerts(
      [
        inspection({ id: 'a', scheduledAt: onDay(-1) }),
        inspection({ id: 'b', scheduledAt: onDay(-3) }),
        inspection({ id: 'c', scheduledAt: onDay(0) }),
        inspection({ id: 'd', scheduledAt: onDay(4) }),
        inspection({ id: 'e', status: 'IN_PROGRESS', scheduledAt: onDay(0) }),
      ],
      NOW,
    );
    expect(alerts.overdue.map((item) => item.id)).toEqual(['a', 'b']);
    expect(alerts.dueSoon.map((item) => item.id)).toEqual(['c']);
    expect(alerts.alertCount).toBe(3);
  });
});

describe('badge wording', () => {
  it('describes lateness in units a technician can act on', () => {
    expect(formatOverdueFor(new Date(NOW - 5 * MINUTE).toISOString(), NOW)).toBe('5m late');
    expect(formatOverdueFor(new Date(NOW - 3 * HOUR).toISOString(), NOW)).toBe('3h late');
    expect(formatOverdueFor(new Date(NOW - 50 * HOUR).toISOString(), NOW)).toBe('2d late');
  });

  it('never reports negative lateness if the clock drifts backwards', () => {
    expect(formatOverdueFor(new Date(NOW + 5 * MINUTE).toISOString(), NOW)).toBe('0m late');
  });

  it('counts down to a due-soon inspection', () => {
    expect(formatDueIn(new Date(NOW + 45 * MINUTE).toISOString(), NOW)).toBe('Due in 45m');
    expect(formatDueIn(new Date(NOW + 90 * MINUTE).toISOString(), NOW)).toBe('Due in 1h 30m');
    expect(formatDueIn(new Date(NOW + 2 * HOUR).toISOString(), NOW)).toBe('Due in 2h');
  });
});
