import type { VisitFilterOutcome, VisitServicesReport } from '@texasrenters/shared';

import {
  filterRows,
  jobChecklistProblems,
  jobTasks,
  toggledService,
  withFilterAnswer,
  withServiceAnswer,
  withServicePhoto,
  withoutFilter,
  withoutServiceAnswer,
} from '../src/utils/job-tasks';

/**
 * The job's checklist, as the office numbers it: "1.Filter Change 2.Pest
 * Control 3.HVAC / Occupied Inspection" (their instruction on every
 * benefit-package visit, and the list they asked for on the phone 2026-09-18).
 */

const DETAILS =
  'Filter Change: 20x25x1 (2 pcs) upstairs hallway; 12x12x1 downstairs + Pest Control + Occupied Inspection';

const answer = (over: Partial<VisitFilterOutcome> = {}): VisitFilterOutcome => ({
  size: '20x25x1',
  location: 'upstairs hallway',
  slot: 1,
  changed: true,
  reason: null,
  photoId: 'photo-1',
  booked: true,
  ...over,
});

const report = (over: Partial<VisitServicesReport> = {}): VisitServicesReport => ({
  services: {},
  filtersInstalled: [],
  notes: null,
  ...over,
});

const tasksFor = (over: Partial<Parameters<typeof jobTasks>[0]> = {}) =>
  jobTasks({
    visitDetails: DETAILS,
    inspectionType: 'OCCUPIED',
    areas: { completed: 0, total: 11 },
    ...over,
  });

describe('the tasks a job has', () => {
  it('is what the visit booked, numbered as the office numbers it', () => {
    expect(tasksFor().map((task) => [task.number, task.title, task.kind])).toEqual([
      [1, 'AC filter change', 'FILTERS'],
      [2, 'Pest control', 'SERVICE'],
      [3, 'Occupied inspection', 'INSPECTION'],
    ]);
  });

  it('names the inspection by the job, so an HVAC visit does not say occupied', () => {
    const [last] = tasksFor({ inspectionType: 'HVAC' }).slice(-1);

    expect(last).toMatchObject({ title: 'HVAC inspection', kind: 'INSPECTION' });
  });

  it('shows only what a filters-only visit books, and no inspection to walk', () => {
    const tasks = tasksFor({
      visitDetails: 'Filter Change: 20x25x1',
      areas: { completed: 0, total: 0 },
    });

    expect(tasks.map((task) => task.key)).toEqual(['filterChange']);
  });

  it('includes flea treatment where the visit books it', () => {
    const tasks = tasksFor({ visitDetails: 'Filter Change: 20x25x1 + Pest Control + Flea Treatment' });

    expect(tasks.map((task) => task.key)).toEqual([
      'filterChange',
      'pestControl',
      'fleaTreatment',
      // The areas are still there to walk: flea treatment is booked alongside.
      'inspection',
    ]);
  });

  it('starts every task as still to do', () => {
    expect(tasksFor().map((task) => task.state)).toEqual(['TODO', 'TODO', 'TODO']);
    expect(tasksFor()[0]!.detail).toBe('3 to photograph');
  });
});

describe('how a task reads as the work happens', () => {
  const filterChange = { done: true, reason: null, reschedule: false };

  it('counts the registers answered while the filter change is part-done', () => {
    const tasks = tasksFor({
      report: report({ services: { filterChange }, filters: [answer()] }),
    });

    expect(tasks[0]).toMatchObject({ state: 'PART', detail: '1 of 3 answered' });
  });

  it('is done once every register is photographed, and says how many were missed', () => {
    const all = [
      answer(),
      answer({ slot: 2, photoId: 'photo-2' }),
      answer({ size: '12x12x1', location: 'downstairs', changed: false, reason: 'Painted over', photoId: null }),
    ];

    const tasks = tasksFor({ report: report({ services: { filterChange }, filters: all }) });

    expect(tasks[0]).toMatchObject({ state: 'DONE', detail: '2 changed · 1 not changed' });
  });

  it('counts a register whose photograph is still uploading as answered', () => {
    // The image travels in the upload queue; the key is what the handset has.
    const tasks = tasksFor({
      report: report({
        services: { filterChange },
        filters: [answer({ photoId: null, photoKey: 'snapshot-1' })],
      }),
    });

    expect(tasks[0]).toMatchObject({ state: 'PART', detail: '1 of 3 answered' });
  });

  it('does not count a register marked changed with no photograph as answered', () => {
    const tasks = tasksFor({
      report: report({ services: { filterChange }, filters: [answer({ photoId: null })] }),
    });

    expect(tasks[0]).toMatchObject({ state: 'PART', detail: '0 of 3 answered' });
  });

  it('stops asking about registers once the filter change itself is marked not done', () => {
    const tasks = tasksFor({
      report: report({
        services: { filterChange: { done: false, reason: 'Nobody home', reschedule: true } },
      }),
    });

    expect(tasks[0]).toMatchObject({ state: 'NOT_DONE', detail: 'Nobody home' });
  });

  it('reads pest control from its one answer, with the reason when it did not happen', () => {
    const done = tasksFor({ report: report({ services: { pestControl: { done: true, reason: null, reschedule: false } } }) });
    expect(done[1]).toMatchObject({ state: 'DONE', detail: null });

    const not = tasksFor({
      report: report({ services: { pestControl: { done: false, reason: 'Newborn in the house', reschedule: true } } }),
    });
    expect(not[1]).toMatchObject({ state: 'NOT_DONE', detail: 'Newborn in the house' });
  });

  it("mentions pest control's optional photograph only when there is one", () => {
    const pestControl = { done: true, reason: null, reschedule: false, photoKey: 'snapshot-3' };
    const sending = tasksFor({ report: report({ services: { pestControl: { ...pestControl, photoId: null } } }) });
    expect(sending[1]).toMatchObject({ state: 'DONE', detail: 'Done · photo sending' });

    const arrived = tasksFor({ report: report({ services: { pestControl: { ...pestControl, photoId: 'photo-3' } } }) });
    expect(arrived[1]).toMatchObject({ state: 'DONE', detail: 'Done · photo' });
  });

  it('follows the areas for the inspection', () => {
    expect(tasksFor({ areas: { completed: 6, total: 11 } }).at(-1)).toMatchObject({
      state: 'PART',
      detail: '6 of 11 areas',
    });
    expect(tasksFor({ areas: { completed: 11, total: 11 } }).at(-1)).toMatchObject({ state: 'DONE' });
  });
});

describe('the registers the checklist asks about', () => {
  it('lists each one the visit booked, named the way the office reads it', () => {
    expect(filterRows(DETAILS, null).map((row) => row.label)).toEqual([
      '20x25x1 · upstairs hallway (1 of 2)',
      '20x25x1 · upstairs hallway (2 of 2)',
      '12x12x1 · downstairs',
    ]);
  });

  it('carries each answer onto its register', () => {
    const rows = filterRows(DETAILS, report({ filters: [answer({ slot: 2, photoId: 'photo-2' })] }));

    expect(rows.map((row) => row.answer?.photoId ?? null)).toEqual([null, 'photo-2', null]);
  });

  it('adds a register the technician found on site, after the booked ones', () => {
    const found = answer({ size: '16x20x1', location: null, slot: 1, booked: false, photoId: 'photo-9' });

    const rows = filterRows(DETAILS, report({ filters: [found] }));

    expect(rows).toHaveLength(4);
    expect(rows[3]).toMatchObject({ label: '16x20x1', answer: found });
  });

  it('says so when the coordinator listed no sizes at all', () => {
    expect(filterRows('Filter Change + Pest Control', null)).toEqual([]);
    expect(jobTasks({ visitDetails: 'Filter Change + Pest Control', inspectionType: 'OCCUPIED', areas: { completed: 0, total: 3 } })[0]!.detail).toBe(
      'No sizes given — check the filters on site',
    );
  });
});

describe('what stops the job being submitted', () => {
  it('is the same list the server would answer with', () => {
    expect(jobChecklistProblems(DETAILS, null)).toEqual([
      'Mark AC filter change done or not done.',
      'Mark pest control done or not done.',
    ]);
  });

  it('asks for the registers once the filter change is ticked done', () => {
    const problems = jobChecklistProblems(
      DETAILS,
      report({
        services: {
          filterChange: { done: true, reason: null, reschedule: false },
          pestControl: { done: true, reason: null, reschedule: false },
        },
        filters: [answer()],
      }),
    );

    expect(problems).toEqual([
      'Answer for the 20x25x1 · upstairs hallway (2 of 2) filter.',
      'Answer for the 12x12x1 · downstairs filter.',
    ]);
  });

  it('is empty once everything the visit booked is answered', () => {
    const problems = jobChecklistProblems(
      DETAILS,
      report({
        services: {
          filterChange: { done: true, reason: null, reschedule: false },
          pestControl: { done: false, reason: 'Newborn in the house', reschedule: true },
        },
        filters: [
          answer(),
          answer({ slot: 2, photoId: 'photo-2' }),
          answer({ size: '12x12x1', location: 'downstairs', changed: false, reason: 'Painted over', photoId: null }),
        ],
      }),
    );

    expect(problems).toEqual([]);
  });
});

describe('writing an answer into the checklist', () => {
  const register = { size: '20x25x1', location: 'upstairs hallway', slot: 1 };

  it('starts a report from nothing, for the first tick of the job', () => {
    const next = withServiceAnswer(null, 'pestControl', { done: true, reason: null, reschedule: false });

    expect(next).toEqual({
      services: { pestControl: { done: true, reason: null, reschedule: false } },
      filters: [],
      filtersInstalled: [],
      notes: null,
    });
  });

  it('marks the filter change done as soon as a register is answered', () => {
    // Answering a register means the technician was at it.
    const next = withFilterAnswer(null, register, { changed: true, photoKey: 'snapshot-1' });

    expect(next.services.filterChange).toEqual({ done: true, reason: null, reschedule: false });
    expect(next.filters).toEqual([
      {
        size: '20x25x1',
        location: 'upstairs hallway',
        slot: 1,
        changed: true,
        reason: null,
        photoId: null,
        photoKey: 'snapshot-1',
        booked: true,
      },
    ]);
  });

  it('replaces the answer for a register rather than adding a second', () => {
    const once = withFilterAnswer(null, register, { changed: true, photoKey: 'snapshot-1' });
    const twice = withFilterAnswer(once, register, { changed: false, reason: 'Painted over' });

    expect(twice.filters).toHaveLength(1);
    expect(twice.filters?.[0]).toMatchObject({ changed: false, reason: 'Painted over', photoKey: null });
  });

  it('keeps the photograph when a register already photographed is ticked again', () => {
    const once = withFilterAnswer(null, register, { changed: true, photoKey: 'snapshot-1' });
    const again = withFilterAnswer(once, register, { changed: true });

    expect(again.filters?.[0]).toMatchObject({ photoKey: 'snapshot-1' });
  });

  it('does not overwrite a filter change already marked not done', () => {
    const notDone = withServiceAnswer(null, 'filterChange', {
      done: false,
      reason: 'Nobody home',
      reschedule: true,
    });

    expect(withServiceAnswer(notDone, 'pestControl', { done: true, reason: null, reschedule: false }).services.filterChange).toEqual({
      done: false,
      reason: 'Nobody home',
      reschedule: true,
    });
  });

  it('attaches an optional photograph to a service, which means it was done', () => {
    expect(withServicePhoto(null, 'pestControl', 'snapshot-4').services.pestControl).toEqual({
      done: true,
      reason: null,
      reschedule: false,
      photoKey: 'snapshot-4',
      photoId: null,
    });

    const notDone = withServiceAnswer(null, 'pestControl', { done: false, reason: 'Dog loose', reschedule: true });
    expect(withServicePhoto(notDone, 'pestControl', 'snapshot-5').services.pestControl).toEqual({
      done: true,
      reason: null,
      reschedule: false,
      photoKey: 'snapshot-5',
      photoId: null,
    });
  });

  it('replaces a service photograph that is retaken, until the new one arrives', () => {
    const first = withServicePhoto(null, 'pestControl', 'snapshot-4');
    const arrived = report({ services: { pestControl: { ...first.services.pestControl!, photoId: 'photo-4' } } });

    expect(withServicePhoto(arrived, 'pestControl', 'snapshot-6').services.pestControl).toMatchObject({
      photoKey: 'snapshot-6',
      photoId: null,
    });
  });

  it("keeps a service's photograph when it is ticked done again, and drops it when it was not done after all", () => {
    const photographed = withServicePhoto(null, 'fleaTreatment', 'snapshot-7');
    const again = withServiceAnswer(photographed, 'fleaTreatment', { done: true, reason: null, reschedule: false });
    expect(again.services.fleaTreatment).toMatchObject({ done: true, photoKey: 'snapshot-7' });

    const undone = withServiceAnswer(photographed, 'fleaTreatment', {
      done: false,
      reason: 'Tenant refused',
      reschedule: true,
    });
    // A photograph of a treatment that did not happen would evidence nothing.
    expect(undone.services.fleaTreatment).toEqual({ done: false, reason: 'Tenant refused', reschedule: true });
  });

  it('never asks for a service photograph before the job can be submitted', () => {
    const noFilters = withServiceAnswer(null, 'filterChange', {
      done: false,
      reason: 'No filters on the truck',
      reschedule: true,
    });
    const done = withServiceAnswer(noFilters, 'pestControl', { done: true, reason: null, reschedule: false });
    expect(jobChecklistProblems(DETAILS, done)).toEqual([]);
  });

  it('records a register found on site as not booked, and can drop it again', () => {
    const found = { size: '16x20x1', location: null, slot: 1 };
    const added = withFilterAnswer(null, found, { changed: true, photoKey: 'snapshot-9' }, { booked: false });

    expect(added.filters?.[0]).toMatchObject({ size: '16x20x1', booked: false });
    expect(withoutFilter(added, found).filters).toEqual([]);
  });
});

/** The office (2026-09-18): "Pest control just a check box". */
describe('pest control as a checkbox', () => {
  it('ticks it done, and unticks it back to unanswered', () => {
    const ticked = toggledService(null, 'pestControl');
    expect(ticked.services.pestControl).toEqual({ done: true, reason: null, reschedule: false });

    const unticked = toggledService(ticked, 'pestControl');
    expect(unticked.services.pestControl).toBeUndefined();
    expect(tasksFor({ report: unticked }).find((task) => task.key === 'pestControl')?.state).toBe('TODO');
  });

  it('ticks done a service that was answered not done', () => {
    const notDone = withServiceAnswer(null, 'pestControl', { done: false, reason: 'Tenant refused', reschedule: true });

    expect(toggledService(notDone, 'pestControl').services.pestControl).toEqual({ done: true, reason: null, reschedule: false });
  });

  it('takes one service’s answer away and leaves the rest of the report alone', () => {
    const both = withServiceAnswer(withServiceAnswer(null, 'pestControl', { done: true, reason: null, reschedule: false }), 'fleaTreatment', {
      done: true,
      reason: null,
      reschedule: false,
    });

    const left = withoutServiceAnswer(both, 'pestControl');
    expect(Object.keys(left.services)).toEqual(['fleaTreatment']);
    expect(left.filters).toEqual([]);
  });
});
