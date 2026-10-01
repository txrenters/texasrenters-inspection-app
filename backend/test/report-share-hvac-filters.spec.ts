import { ReportShareService } from '../src/admin/report-share.service';

/**
 * The HVAC report's Filters table, read from the job's AC filter change.
 *
 * Moses, 2026-10-01: the filters are scored on the AC filter change now, not in
 * a Filters section of the inspection. The report keeps printing them where the
 * office's HVAC report always has -- after the Attic -- one row per filter the
 * house really has, with the filter change's photograph beneath.
 */

const photo = (id: string) => ({
  id,
  label: null,
  notes: null,
  capturedAt: new Date('2026-10-01T15:00:00Z'),
  captureTimeSource: 'DEVICE_CLOCK',
  width: 1200,
  height: 900,
  checklistItem: null,
});

const area = (id: string, name: string, over: Record<string, unknown> = {}) => ({
  id,
  propertyAreaId: `property-${id}`,
  completionStatus: 'COMPLETED',
  skipReason: null,
  completedAt: new Date('2026-10-01T16:00:00Z'),
  propertyArea: { name, source: 'SYSTEM', floor: null },
  checklistResponses: [],
  photos: [],
  ...over,
});

const SERVICES_REPORT = {
  services: { filterChange: { done: true, reason: null, reschedule: false } },
  filtersInstalled: ['20x20x1'],
  filters: [
    {
      size: '20x25x1',
      location: 'hallway',
      slot: 1,
      changed: true,
      reason: null,
      photoId: 'filter-photo',
      booked: true,
      isClean: false,
      isUndamaged: true,
      isWorking: true,
      comment: 'Very dusty',
      actualSize: '20x20x1',
    },
    {
      size: '12x12x1',
      location: 'downstairs',
      slot: 1,
      changed: false,
      reason: null,
      photoId: null,
      booked: true,
      removed: true,
    },
  ],
};

function build(areas: unknown[], over: Record<string, unknown> = {}) {
  const prisma = {
    inspectionReportShare: {
      findUnique: jest.fn().mockResolvedValue({
        inspectionId: 'inspection-1',
        expiresAt: new Date(Date.now() + 86_400_000),
        revokedAt: null,
        createdBy: { displayName: 'Operations Team' },
      }),
    },
    inspection: {
      findUnique: jest.fn().mockResolvedValue({
        inspectionType: 'HVAC',
        assignments: [],
        status: 'COMPLETED',
        scheduledAt: new Date('2026-10-01T00:00:00Z'),
        completedAt: new Date('2026-10-01T18:00:00Z'),
        servicesReport: SERVICES_REPORT,
        propertywareBuilding: null,
        areas,
        findings: [],
        ...over,
      }),
    },
  };
  return new ReportShareService(prisma as never);
}

const AREAS = [
  area('attic', 'Attic'),
  // An inspection made before the change still has its Filters section, never walked.
  area('filters', 'Filters', { completionStatus: 'PENDING' }),
  area('ac-unit', 'A/C unit'),
  area('thermostat', 'Thermostat'),
  area('ac-filters', 'AC filters', { photos: [photo('filter-photo'), photo('stray-photo')] }),
];

describe('the shared report of an HVAC inspection', () => {
  it('prints the filters scored on the AC filter change after the Attic', async () => {
    const report = await build(AREAS).publicReport('valid-token');

    expect(report.rooms.map((room) => room.name)).toEqual(['Attic', 'Filters', 'A/C unit', 'Thermostat']);
    const filters = report.rooms[1]!;
    expect(filters.id).toBe('ac-filters');
    // The filter really there, by its real size; nothing for the one that is not.
    expect(filters.checklist).toEqual([
      expect.objectContaining({
        label: 'Filter 1 · 20x20x1 · hallway',
        isClean: false,
        isUndamaged: true,
        isWorking: true,
        comment: 'Very dusty',
      }),
    ]);
  });

  it('carries the filter change’s photograph under it, and only that one', async () => {
    const report = await build(AREAS).publicReport('valid-token');

    expect(report.photos.filter((entry) => entry.roomId === 'ac-filters').map((entry) => entry.id)).toEqual([
      'filter-photo',
    ]);
  });

  it('prints a Filters section that was walked as it was, and nothing on top of it', async () => {
    const walked = AREAS.map((entry) => (entry.id === 'filters' ? { ...entry, completionStatus: 'COMPLETED' } : entry));
    const report = await build(walked).publicReport('valid-token');

    expect(report.rooms.map((room) => room.id)).toEqual(['attic', 'filters', 'ac-unit', 'thermostat']);
  });

  it('prints no Filters table for an HVAC job that answered none', async () => {
    const report = await build(AREAS, { servicesReport: null }).publicReport('valid-token');

    expect(report.rooms.map((room) => room.name)).toEqual(['Attic', 'A/C unit', 'Thermostat']);
  });

  it('adds nothing to any other kind of report', async () => {
    const report = await build([area('kitchen', 'Kitchen', { propertyArea: { name: 'Kitchen', source: 'TEMPLATE', floor: null } })], {
      inspectionType: 'OCCUPIED',
    }).publicReport('valid-token');

    expect(report.rooms.map((room) => room.name)).toEqual(['Kitchen']);
  });
});
