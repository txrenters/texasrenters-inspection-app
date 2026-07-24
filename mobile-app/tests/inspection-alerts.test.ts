import type { Inspection } from '../src/domain/models';
import {
  collectInspectionAlerts,
  DUE_SOON_WINDOW_MS,
  inspectionUrgency,
} from '../src/utils/inspection-alerts';

const NOW = Date.parse('2026-07-25T12:00:00.000Z');

function inspection(overrides: Partial<Inspection>): Inspection {
  return {
    id: 'i1',
    externalInspectionId: 'x1',
    propertyId: 'p1',
    type: 'MOVE_IN',
    scheduledAt: new Date(NOW).toISOString(),
    assignedUserId: 'tech-1',
    status: 'SCHEDULED',
    priority: 'STANDARD',
    roomIds: [],
    propertyNotes: '',
    property: { id: 'p1', address: '1 Main', cityStateZip: 'TX', imageTone: 'navy' },
    progress: { completed: 0, total: 8, hasFailedUpload: false },
    ...overrides,
  } as Inspection;
}

describe('inspectionUrgency', () => {
  it('flags a past-due scheduled inspection as overdue', () => {
    const result = inspectionUrgency(
      inspection({ scheduledAt: new Date(NOW - 60_000).toISOString() }),
      NOW,
    );
    expect(result).toBe('overdue');
  });

  it('flags an inspection within the due-soon window', () => {
    const result = inspectionUrgency(
      inspection({ scheduledAt: new Date(NOW + DUE_SOON_WINDOW_MS - 60_000).toISOString() }),
      NOW,
    );
    expect(result).toBe('due_soon');
  });

  it('treats a far-future scheduled inspection as merely scheduled', () => {
    const result = inspectionUrgency(
      inspection({ scheduledAt: new Date(NOW + DUE_SOON_WINDOW_MS + 60_000).toISOString() }),
      NOW,
    );
    expect(result).toBe('scheduled');
  });

  it('does not warn once the inspection has started or finished', () => {
    for (const status of ['IN_PROGRESS', 'PROCESSING', 'COMPLETED', 'CANCELLED'] as const) {
      expect(
        inspectionUrgency(
          inspection({ status, scheduledAt: new Date(NOW - 60_000).toISOString() }),
          NOW,
        ),
      ).toBeNull();
    }
  });
});

describe('collectInspectionAlerts', () => {
  it('partitions and counts overdue and due-soon assignments', () => {
    const alerts = collectInspectionAlerts(
      [
        inspection({ id: 'overdue', scheduledAt: new Date(NOW - 3_600_000).toISOString() }),
        inspection({ id: 'soon', scheduledAt: new Date(NOW + 60_000).toISOString() }),
        inspection({ id: 'later', scheduledAt: new Date(NOW + 24 * 3_600_000).toISOString() }),
        inspection({ id: 'done', status: 'COMPLETED', scheduledAt: new Date(NOW - 60_000).toISOString() }),
      ],
      NOW,
    );
    expect(alerts.overdueCount).toBe(1);
    expect(alerts.dueSoonCount).toBe(1);
    expect(alerts.alertCount).toBe(2);
    expect(alerts.overdue[0]?.id).toBe('overdue');
    expect(alerts.dueSoon[0]?.id).toBe('soon');
  });
});
