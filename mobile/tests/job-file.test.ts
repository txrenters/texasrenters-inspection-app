import type { JobFile, JobLastVisit } from '../src/domain/models';
import { jobFileRows, lastVisitNotes } from '../src/utils/job-file';

/**
 * The office's file, at the door. Until this, a technician had the
 * coordinator's Details and nothing else (the office, 2026-09-18).
 */

const FILE: JobFile = {
  tenantNames: ['Rosa Alvarez', 'Luis Alvarez'],
  plan: 'Basic',
  hvacPlan: 'Opted out',
  benefitPackage: 'Enrolled',
  filterSizes: ['20x25x1', '12x12x1'],
  filterLocation: 'Upstairs hallway',
  lastFilterDelivery: 'June 2026',
  lastHvacInspection: '2026-03-12',
  lastOccupiedInspection: '2026-06-18',
  movedIn: '2024-03-01',
  leaseEnds: '2027-02-28',
};

const value = (rows: { label: string; value: string }[], label: string) =>
  rows.find((row) => row.label === label)?.value;

describe('the file the office holds on a tenancy', () => {
  it('reads as rows in the order a technician needs them', () => {
    expect(jobFileRows(FILE).map((row) => row.label)).toEqual([
      'Tenant',
      'Plan',
      'HVAC plan',
      'Filters on file',
      'Last filters',
      'Last HVAC',
      'Last occupied',
      'Moved in',
      'Lease ends',
    ]);
  });

  it('puts the sizes and where they are on one line', () => {
    expect(value(jobFileRows(FILE), 'Filters on file')).toBe('20x25x1, 12x12x1 · Upstairs hallway');
  });

  it('shows a location on its own when the office holds no sizes', () => {
    const rows = jobFileRows({ ...FILE, filterSizes: [] });

    expect(value(rows, 'Filters on file')).toBe('Upstairs hallway');
  });

  it('drops the filter row when neither is known', () => {
    const rows = jobFileRows({ ...FILE, filterSizes: [], filterLocation: undefined });

    expect(rows.map((row) => row.label)).not.toContain('Filters on file');
  });

  it('reads a date as the day it is, not the evening before in Texas', () => {
    // `2024-03-01` is a date, not an instant: localising it moves the day back.
    expect(value(jobFileRows(FILE), 'Moved in')).toBe('Mar 1, 2024');
    expect(value(jobFileRows(FILE), 'Lease ends')).toBe('Feb 28, 2027');
    expect(value(jobFileRows(FILE), 'Last HVAC')).toBe('Mar 12, 2026');
  });

  it('leaves the report’s own wording alone where it is not a date', () => {
    // The tenant report writes "June 2026" as often as a day, and inventing a
    // date the office never recorded would be worse than showing its words.
    expect(value(jobFileRows(FILE), 'Last filters')).toBe('June 2026');
    expect(value(jobFileRows({ ...FILE, lastFilterDelivery: '2026-06-02' }), 'Last filters')).toBe('Jun 2, 2026');
  });

  it('is empty for a tenancy the office could not resolve', () => {
    expect(jobFileRows(undefined)).toEqual([]);
    expect(jobFileRows({ tenantNames: [], filterSizes: [] })).toEqual([]);
  });
});

describe('what the last visit flagged', () => {
  const VISIT: JobLastVisit = {
    scheduledAt: '2026-06-18T00:00:00.000Z',
    type: 'OCCUPIED',
    nextInspectionAlert: 'Check the water heater pan.',
    maintenanceComments: 'Tenant reported a slow drain.',
  };

  it('says when it was, and what to watch for', () => {
    const notes = lastVisitNotes(VISIT);

    expect(notes?.when).toBe('Jun 18, 2026 · occupied inspection');
    expect(notes?.notes).toEqual([
      { label: 'Watch for', value: 'Check the water heater pan.' },
      { label: 'Maintenance', value: 'Tenant reported a slow drain.' },
    ]);
  });

  it('keeps only the part somebody wrote', () => {
    const notes = lastVisitNotes({ ...VISIT, maintenanceComments: '   ' });

    expect(notes?.notes.map((note) => note.label)).toEqual(['Watch for']);
  });

  it('says nothing at all for a visit that flagged nothing', () => {
    expect(lastVisitNotes(undefined)).toBeNull();
    expect(lastVisitNotes({ ...VISIT, nextInspectionAlert: '', maintenanceComments: undefined })).toBeNull();
  });
});
