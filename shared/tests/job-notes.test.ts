import { describe, expect, it } from 'vitest';
import {
  jobAreaNotes,
  reportComments,
  technicianNotes,
  type JobAreaNoteRow,
  type VisitServicesReport,
} from '../src/index.js';

const report = (over: Partial<VisitServicesReport> = {}): VisitServicesReport => ({
  services: {},
  filtersInstalled: [],
  notes: null,
  ...over,
});

const filter = {
  size: '20x25x1',
  location: 'Hallway',
  slot: 1,
  changed: false,
  reason: null,
  photoId: null,
  booked: true,
};

const row = (over: Partial<JobAreaNoteRow> & { order?: number; name?: string }): JobAreaNoteRow => {
  const { order = 1, name = 'Kitchen', ...rest } = over;
  return {
    id: 'area-1',
    completionStatus: 'COMPLETE',
    technicianNote: null,
    skipReason: null,
    propertyArea: { name, inspectionOrder: order, floor: null },
    ...rest,
  };
};

const lines = (job: Parameters<typeof technicianNotes>[0]) =>
  technicianNotes(job).map((note) => `${note.source}: ${note.text}`);

describe('technicianNotes', () => {
  it('has nothing to say about a job nobody wrote on', () => {
    expect(technicianNotes({})).toEqual([]);
    expect(technicianNotes({ servicesReport: report(), areaNotes: [] })).toEqual([]);
  });

  it('says why nobody got in, without repeating the words its label already says', () => {
    expect(lines({ completionBlockedReason: 'Could not get in: Tenant not home' })).toEqual([
      'Could not get in: Tenant not home',
    ]);
  });

  it('leaves out a reason the office wrote, in the same column, to hold a job back', () => {
    expect(lines({ completionBlockedReason: 'Pending administrator determination.' })).toEqual([]);
  });

  it('lists the visit, then its services, filters and rooms, each named for where it was written', () => {
    expect(
      lines({
        completionBlockedReason: 'Could not get in: Dog in the yard',
        servicesReport: report({
          notes: 'Gate was left open.',
          services: {
            pestControl: { done: false, reason: 'Tenant refused', reschedule: false },
            filterChange: { done: true, reason: null, reschedule: false },
          },
          filters: [{ ...filter, reason: 'Wrong size on the truck' }],
        }),
        areaNotes: [
          { id: 'a', name: 'Kitchen', floorName: null, note: 'Sink drips.', skipReason: null },
        ],
      }),
    ).toEqual([
      'Could not get in: Dog in the yard',
      'Note for the office: Gate was left open.',
      'Pest control: Tenant refused',
      'Filter 20x25x1 · Hallway: Wrong size on the truck',
      'Kitchen: Sink drips.',
    ]);
  });

  it("joins a filter's reason and comment, and takes either alone", () => {
    expect(
      lines({
        servicesReport: report({
          filters: [
            { ...filter, reason: 'Not at the property', comment: 'Return is boarded up' },
            { ...filter, slot: 2, changed: true, comment: 'Not present' },
          ],
        }),
      }),
    ).toEqual([
      'Filter 20x25x1 · Hallway: Not at the property — Return is boarded up',
      'Filter 20x25x1 · Hallway: Not present',
    ]);
  });

  it('gives each filter its own key, so two the same do not collide on the page', () => {
    const keys = technicianNotes({
      servicesReport: report({ filters: [{ ...filter, reason: 'One' }, { ...filter, reason: 'Two' }] }),
    }).map((note) => note.key);
    expect(new Set(keys).size).toBe(2);
  });

  it('names a room with its floor, and shows both a skip reason and a note', () => {
    expect(
      lines({
        areaNotes: [
          { id: 'a', name: 'Bedroom 2', floorName: 'Upstairs', note: 'Tenant asleep.', skipReason: 'No access' },
        ],
      }),
    ).toEqual(['Bedroom 2 · Upstairs: Skipped: No access', 'Bedroom 2 · Upstairs: Tenant asleep.']);
  });

  it('ignores what is only spaces', () => {
    expect(
      lines({
        servicesReport: report({ notes: '   ' }),
        areaNotes: [{ id: 'a', name: 'Kitchen', floorName: null, note: '  ', skipReason: ' ' }],
      }),
    ).toEqual([]);
  });
});

describe('jobAreaNotes', () => {
  it('lists rooms in walk order, then by name', () => {
    const notes = jobAreaNotes([
      row({ id: 'c', order: 2, name: 'Garage', technicianNote: 'c' }),
      row({ id: 'b', order: 1, name: 'Kitchen', technicianNote: 'b' }),
      row({ id: 'a', order: 1, name: 'Bedroom', technicianNote: 'a' }),
    ]);
    expect(notes.map((note) => note.id)).toEqual(['a', 'b', 'c']);
  });

  it('keeps a skip reason only on a room still skipped: a resumed room can keep the old one', () => {
    expect(
      jobAreaNotes([
        row({ id: 'a', completionStatus: 'SKIPPED', skipReason: 'Locked' }),
        row({ id: 'b', order: 2, completionStatus: 'COMPLETE', skipReason: 'Locked', technicianNote: 'Opened later.' }),
      ]).map(({ skipReason, note }) => ({ skipReason, note })),
    ).toEqual([
      { skipReason: 'Locked', note: null },
      { skipReason: null, note: 'Opened later.' },
    ]);
  });

  it('carries the floor', () => {
    const [note] = jobAreaNotes([
      { ...row({ technicianNote: 'x' }), propertyArea: { name: 'Bath', inspectionOrder: 1, floor: { name: 'Upstairs' } } },
    ]);
    expect(note).toMatchObject({ name: 'Bath', floorName: 'Upstairs' });
  });
});

describe('reportComments', () => {
  it("lists the report's closing comments in the order it prints them, without the empty ones", () => {
    expect(
      reportComments({
        nextInspectionAlert: 'Bring a ladder.',
        maintenanceComments: '  ',
        generalComments: 'All good.',
      }).map(({ source, text }) => [source, text]),
    ).toEqual([
      ['Next inspection alert', 'Bring a ladder.'],
      ['General comments', 'All good.'],
    ]);
  });

  it('is empty when nothing was written', () => {
    expect(reportComments({})).toEqual([]);
  });
});
