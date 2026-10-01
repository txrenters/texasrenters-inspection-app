import { MutationCache, QueryCache, QueryClient } from '@tanstack/react-query';
import type { VisitFilterOutcome, VisitServicesReport } from '@texasrenters/shared';

import { planEndJob } from '../src/utils/end-job';
import {
  filterRows,
  filterRowSettled,
  filterRulesFor,
  jobChecklistProblems,
  jobTasks,
  withFilterAnswer,
  withFilterAssessment,
  withFilterRemoved,
  withFilterSize,
  withFilterUndeclined,
  withFiltersPhoto,
} from '../src/utils/job-tasks';

/**
 * An HVAC job's filters, on its AC filter change (Moses, 2026-10-01).
 *
 * "Keep the AC filter change and remove it from the HVAC inspection part of it.
 * Include the questions on the AC filter change part of it." And: "make it where
 * I can adjust the amount of filters, remove or change as necessary". Every HVAC
 * job has the task; each filter is scored Clean / Undamaged / Working; the one
 * photograph is asked only when the visit booked a filter change. Occupied jobs
 * are as they were.
 */

const BOOKED = 'Filter Change: 20x25x1 hallway; 12x12x1 downstairs + HVAC Inspection';
const UNBOOKED = 'HVAC Inspection';
const hallway = { size: '20x25x1', location: 'hallway', slot: 1 };
const downstairs = { size: '12x12x1', location: 'downstairs', slot: 1 };
const scored = { isClean: true, isUndamaged: true, isWorking: false };

const answer = (over: Partial<VisitFilterOutcome> = {}): VisitFilterOutcome => ({
  ...hallway,
  changed: true,
  reason: null,
  photoId: null,
  photoKey: 'snap-1',
  booked: true,
  ...over,
});

const report = (filters: VisitFilterOutcome[]): VisitServicesReport => ({
  services: { filterChange: { done: true, reason: null, reschedule: false } },
  filters,
  filtersInstalled: [],
  notes: null,
});

const filterTask = (visitDetails: string, inspectionType: string, servicesReport?: VisitServicesReport) =>
  jobTasks({ visitDetails, inspectionType, report: servicesReport, areas: { completed: 0, total: 3 } }).find(
    (task) => task.kind === 'FILTERS',
  );

describe('the AC filter change on an HVAC job', () => {
  it('is there whether or not the visit booked one', () => {
    expect(filterTask(UNBOOKED, 'HVAC')).toBeDefined();
    expect(filterTask(BOOKED, 'HVAC')!.detail).toBe('2 filters · score each, one photo');
  });

  it('is not added to an occupied job that booked none', () => {
    expect(filterTask('Pest Control + Occupied Inspection', 'OCCUPIED')).toBeUndefined();
    expect(filterTask('Filter Change: 20x25x1 + Occupied Inspection', 'OCCUPIED')!.detail).toBe('1 filter · one photo');
  });

  it('is done once every filter is scored and photographed, and counts the ones not there', () => {
    const task = filterTask(
      BOOKED,
      'HVAC',
      report([answer(scored), answer({ ...downstairs, changed: false, photoKey: null, removed: true })]),
    )!;
    expect(task.state).toBe('DONE');
    expect(task.detail).toBe('1 changed · 1 not there');
  });

  it('is part done while a photographed filter is still unscored', () => {
    const task = filterTask(BOOKED, 'HVAC', report([answer(), answer({ ...downstairs, ...scored })]))!;
    expect(task.state).toBe('PART');
    expect(task.detail).toBe('1 of 2 answered');
  });
});

describe('when a filter needs nothing more', () => {
  const booked = filterRulesFor(BOOKED, 'HVAC');
  const unbooked = filterRulesFor(UNBOOKED, 'HVAC');
  const row = (entry: VisitFilterOutcome) => ({ ...filterRows(BOOKED, null)[0]!, answer: entry });

  it('reads the rules from the job', () => {
    expect(booked).toEqual({ assess: true, changeAsked: true });
    expect(unbooked).toEqual({ assess: true, changeAsked: false });
    expect(filterRulesFor(BOOKED, 'OCCUPIED')).toEqual({ assess: false, changeAsked: true });
  });

  it('asks a booked change for its photograph and its scores', () => {
    expect(filterRowSettled(row(answer()), booked)).toBe(false);
    expect(filterRowSettled(row(answer(scored)), booked)).toBe(true);
    expect(filterRowSettled(row(answer({ changed: false, photoKey: null, ...scored })), booked)).toBe(false);
    expect(filterRowSettled(row(answer({ changed: false, photoKey: null, reason: 'Wrong size', ...scored })), booked)).toBe(true);
  });

  it('asks a visit that booked no change for the scores alone', () => {
    expect(filterRowSettled(row(answer({ changed: false, photoKey: null, ...scored })), unbooked)).toBe(true);
    expect(filterRowSettled(row(answer({ changed: false, photoKey: null, comment: 'Could not reach' })), unbooked)).toBe(true);
    expect(filterRowSettled(row(answer({ changed: false, photoKey: null })), unbooked)).toBe(false);
  });

  it('asks nothing of a filter that is not at the property', () => {
    expect(filterRowSettled(row(answer({ removed: true, changed: false, photoKey: null })), booked)).toBe(true);
  });
});

describe('answering a filter', () => {
  it('folds a score into what is there, and marks the filter change worked', () => {
    let next = withFilterAssessment(null, hallway, { isClean: true });
    next = withFilterAssessment(next, hallway, { isWorking: false });
    expect(next.filters).toEqual([expect.objectContaining({ isClean: true, isWorking: false, booked: true })]);
    expect(next.services.filterChange).toEqual({ done: true, reason: null, reschedule: false });
  });

  it('keeps the scores when the filter is then photographed', () => {
    const next = withFilterAnswer(withFilterAssessment(null, hallway, scored), hallway, { changed: true, photoKey: 'snap-2' });
    expect(next.filters![0]).toMatchObject({ ...scored, changed: true, photoKey: 'snap-2' });
  });

  it('takes a listed filter off, and puts it back', () => {
    const off = withFilterRemoved(report([answer({ photoId: 'p-1' })]), hallway, true);
    expect(off.filters![0]).toMatchObject({ removed: true, changed: false, photoId: null, photoKey: null });
    expect(withFilterRemoved(off, hallway, false).filters![0]).toMatchObject({ removed: false });
  });

  it('leaves a filter not there out of the one photograph', () => {
    const off = withFilterRemoved(null, downstairs, true);
    const next = withFiltersPhoto(off, BOOKED, 'snap-3');
    expect(next.filters!.find((entry) => entry.size === '12x12x1')).toMatchObject({ removed: true, photoKey: null });
    expect(next.filters!.find((entry) => entry.size === '20x25x1')).toMatchObject({ changed: true, photoKey: 'snap-3' });
  });

  it('records the size really there under the listed one, and forgets it when set back', () => {
    const resized = withFilterSize(null, hallway, '20 x 20 x 1');
    expect(resized.filters![0]).toMatchObject({ size: '20x25x1', actualSize: '20x20x1' });
    expect(filterRows(BOOKED, resized)[0]!.label).toBe('20x20x1 · hallway');
    expect(withFilterSize(resized, hallway, '20x25x1').filters![0]!.actualSize).toBeNull();
  });

  it('undoes "not changed" without losing the scores', () => {
    const declined = report([answer({ changed: false, photoKey: null, reason: 'Wrong size', ...scored })]);
    expect(withFilterUndeclined(declined, hallway, null).filters![0]).toMatchObject({ changed: false, reason: null, ...scored });
    expect(withFilterUndeclined(declined, hallway, { photoKey: 'snap-1', photoId: null }).filters![0]).toMatchObject({
      changed: true,
      reason: null,
      photoKey: 'snap-1',
      ...scored,
    });
  });
});

describe('End job on an HVAC job', () => {
  const filters = (state: 'TODO' | 'PART') => ({
    key: 'filterChange' as const,
    kind: 'FILTERS' as const,
    number: 1,
    title: 'Filter change',
    state,
    detail: '1 of 2 answered',
  });
  const ready = { canSubmit: true, incompleteRequiredRooms: [] };

  it('asks for the scores and the photograph when a change was booked', () => {
    const plan = planEndJob([filters('PART')], ready, { assess: true, changeAsked: true });
    expect(plan.blockers[0]).toMatchObject({
      title: 'Finish the filter change first',
      message:
        '1 of 2 answered. Score each filter Clean, Undamaged and Working, and take one photo of them all or say why one was not changed.',
    });
  });

  it('asks for the scores alone when none was', () => {
    const plan = planEndJob([filters('TODO')], ready, { assess: true, changeAsked: false });
    expect(plan.blockers[0]).toMatchObject({
      title: 'Finish the filters first',
      message: '1 of 2 answered. Score each filter Clean, Undamaged and Working, or say why it could not be.',
    });
  });

  it('refuses at submission the way the server will', () => {
    expect(jobChecklistProblems(BOOKED, report([answer(scored), answer({ ...downstairs })]), 'HVAC')).toEqual([
      'Score Clean, Undamaged and Working for the 12x12x1 · downstairs filter, or say why not.',
    ]);
    // The same report on an occupied job asks nothing about scores.
    expect(jobChecklistProblems(BOOKED.replace('HVAC', 'Occupied'), report([answer(), answer({ ...downstairs })]), 'OCCUPIED')).toEqual([]);
  });
});

/**
 * Scoring is three quick taps on one filter, and each is its own answer. They go
 * to the server one at a time, so a reply lands while the next tap is drawn but
 * not sent. `saveServices`' `onSuccess` keeps the drawn checklist while another
 * answer waits; drawing the reply instead took the tap off the screen, and its
 * send -- which reads the cache -- went out without it.
 *
 * Built the way `useInspectionActions` builds it: keep in step with `saveServices`.
 */
describe('scoring quickly while an earlier score is still sending', () => {
  const key = ['inspection', 'job-1'];
  const scope = { id: 'job-services:job-1' };
  let client: QueryClient;

  beforeEach(() => {
    client = new QueryClient({
      queryCache: new QueryCache(),
      mutationCache: new MutationCache(),
      defaultOptions: { queries: { retry: false, gcTime: Infinity }, mutations: { retry: false, gcTime: Infinity } },
    });
    client.setQueryData(key, { id: 'job-1', visitDetails: BOOKED, servicesReport: null });
  });
  afterEach(() => client.clear());

  const waiting = () =>
    client
      .getMutationCache()
      .getAll()
      .filter((mutation) => mutation.options.scope?.id === scope.id && mutation.state.status === 'pending').length;

  const save = (send: (report: unknown) => Promise<unknown>, guarded: boolean) =>
    client.getMutationCache().build(client, {
      scope,
      onMutate: async (update: (current: VisitServicesReport | null) => VisitServicesReport) => {
        const current = client.getQueryData<any>(key)?.servicesReport ?? null;
        client.setQueryData(key, (job?: any) => (job ? { ...job, servicesReport: update(current) } : job));
      },
      mutationFn: async () => send(client.getQueryData<any>(key)?.servicesReport ?? null),
      onSuccess: (inspection: any) => {
        if (guarded && waiting() > 1) {
          client.setQueryData(key, (cached?: any) => (cached ? { ...inspection, servicesReport: cached.servicesReport } : inspection));
          return;
        }
        client.setQueryData(key, inspection);
      },
    });

  const flush = async () => {
    for (let i = 0; i < 12; i += 1) await Promise.resolve();
  };

  /** Clean, then Working before Clean's reply; returns what the server last heard. */
  const scoreTwice = async (guarded: boolean) => {
    const heard: any[] = [];
    let reply: () => void = () => undefined;
    const first = save(
      (sent) =>
        new Promise((resolve) => {
          heard.push(sent);
          reply = () => resolve({ id: 'job-1', visitDetails: BOOKED, servicesReport: sent });
        }),
      guarded,
    );
    void first.execute((current) => withFilterAssessment(current, hallway, { isClean: true }));
    await flush();
    const second = save(async (sent) => {
      heard.push(sent);
      return { id: 'job-1', visitDetails: BOOKED, servicesReport: sent };
    }, guarded);
    void second.execute((current) => withFilterAssessment(current, hallway, { isWorking: true }));
    await flush();
    reply();
    await flush();
    return heard.at(-1).filters[0];
  };

  it('sends both scores', async () => {
    expect(await scoreTwice(true)).toMatchObject({ isClean: true, isWorking: true });
    expect(client.getQueryData<any>(key).servicesReport.filters[0]).toMatchObject({ isClean: true, isWorking: true });
  });

  it('lost the second without the guard -- the defect it stops', async () => {
    expect((await scoreTwice(false)).isWorking).toBeUndefined();
  });
});
