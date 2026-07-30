import type { Inspection } from '../src/domain/models';
import { formatDueIn, formatOverdueFor } from '../src/components/InspectionUrgencyBadge';
import {
  collectInspectionAlerts,
  DUE_SOON_WINDOW_MS,
  inspectionUrgency,
} from '../src/utils/inspection-alerts';

const NOW = new Date('2026-07-31T09:00:00Z').getTime();
const MINUTE = 60_000;
const HOUR = 60 * MINUTE;

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
  it('marks a scheduled inspection overdue once its start time has passed', () => {
    // The reported bug: a past-scheduled inspection showed no indicator at all.
    const past = inspection({ scheduledAt: new Date(NOW - MINUTE).toISOString() });
    expect(inspectionUrgency(past, NOW)).toBe('overdue');
  });

  it('warns inside the two-hour window and stays quiet outside it', () => {
    const soon = inspection({ scheduledAt: new Date(NOW + DUE_SOON_WINDOW_MS - MINUTE).toISOString() });
    const later = inspection({ scheduledAt: new Date(NOW + DUE_SOON_WINDOW_MS + MINUTE).toISOString() });
    expect(inspectionUrgency(soon, NOW)).toBe('due_soon');
    expect(inspectionUrgency(later, NOW)).toBe('scheduled');
  });

  it('stops warning once the technician has started the work', () => {
    // An in-progress inspection is being handled; nagging about it is noise.
    for (const status of ['IN_PROGRESS', 'COMPLETED', 'CANCELLED'] as const) {
      const started = inspection({
        status,
        scheduledAt: new Date(NOW - 5 * HOUR).toISOString(),
      });
      expect(inspectionUrgency(started, NOW)).toBeNull();
    }
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
        inspection({ id: 'a', scheduledAt: new Date(NOW - HOUR).toISOString() }),
        inspection({ id: 'b', scheduledAt: new Date(NOW - 3 * HOUR).toISOString() }),
        inspection({ id: 'c', scheduledAt: new Date(NOW + 30 * MINUTE).toISOString() }),
        inspection({ id: 'd', scheduledAt: new Date(NOW + 8 * HOUR).toISOString() }),
        inspection({ id: 'e', status: 'IN_PROGRESS', scheduledAt: new Date(NOW - HOUR).toISOString() }),
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
