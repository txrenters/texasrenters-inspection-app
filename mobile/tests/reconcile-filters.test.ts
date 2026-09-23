/**
 * The VERIFYING guard must not spread a stale job over a write to it.
 *
 * This is the cause of the bug the office reported on 2026-09-23: a filter
 * added on an AC filter change job did not appear until the app was closed and
 * reopened.
 *
 * `reconcile` is the `structuralSharing` function on every query, so it runs on
 * `setQueryData` too. Start job arms a guard through `completeIntent`, which
 * stores the ENTIRE job as the guard's shadow. Clearing that guard required two
 * comparable revisions -- and a technician's inspection has none, because the
 * backend's `technicianInspectionSummarySelect` sends neither `updatedAt` nor
 * `version`. So the condition could never be satisfied and `applyGuard` spread
 * the old job back over every write for the full thirty seconds the guard
 * lived, including the server's own reply.
 *
 * That is also why a restart cured it: the PATCH had gone out and the server
 * had the filter all along. Only the screen was lied to, by a module-level map
 * that a fresh process clears.
 *
 * Filter outcomes carry no `id`, so reconcile's array branch matches them
 * positionally. The first block pins what that does, because it was the first
 * suspect and it is not the problem.
 */
import { QueryClient } from '@tanstack/react-query';
import { entityRevision } from '@texasrenters/shared';
import {
  reconcileMobileState,
  beginIntent,
  completeIntent,
} from '../src/features/state-consistency';
import { withAddedFilter, filterRows } from '../src/utils/job-tasks';

const filter = (size: string, location: string | null, slot: number, booked: boolean) => ({
  size,
  location,
  slot,
  changed: false,
  reason: null,
  photoId: null,
  photoKey: null,
  booked,
});

const inspectionWith = (filters: ReturnType<typeof filter>[]) => ({
  id: 'insp-1',
  externalInspectionId: 'ext-1',
  propertyId: 'prop-1',
  type: 'HVAC_FILTER',
  scheduledAt: '2026-09-23T14:00:00.000Z',
  assignedUserId: 'tech-1',
  status: 'IN_PROGRESS',
  priority: 'NORMAL',
  roomIds: [],
  allowTechnicianAreaCapture: false,
  updatedAt: '2026-09-23T15:00:00.000Z',
  visitDetails: 'AC filter change\n20x25x1 (Hall)\n16x20x1 (Master)',
  servicesReport: {
    services: {},
    filters,
    filtersInstalled: [],
    notes: null,
  },
});

const booked = [filter('20x25x1', 'Hall', 1, true), filter('16x20x1', 'Master', 1, true)];

describe('reconcileMobileState on servicesReport.filters', () => {
  it('keeps an APPENDED filter (2 -> 3)', () => {
    const previous = inspectionWith(booked);
    const incoming = inspectionWith([...booked, filter('12x12x1', 'Garage', 1, false)]);

    const result = reconcileMobileState(previous, incoming) as typeof incoming;

    expect(result.servicesReport.filters).toHaveLength(3);
    expect(result.servicesReport.filters[2]).toEqual(
      expect.objectContaining({ size: '12x12x1', location: 'Garage', booked: false }),
    );
  });

  it('returns a NEW object identity, so a subscribed component re-renders', () => {
    const previous = inspectionWith(booked);
    const incoming = inspectionWith([...booked, filter('12x12x1', 'Garage', 1, false)]);

    const result = reconcileMobileState(previous, incoming);

    expect(result).not.toBe(previous);
    expect(result).not.toBe(incoming); // reconcile always rebuilds
  });

  it('does NOT blend fields when a removal shifts positions (3 -> 2)', () => {
    const three = [...booked, filter('12x12x1', 'Garage', 1, false)];
    const previous = inspectionWith(three);
    // drop the middle one: index 1 now holds a DIFFERENT filter than before
    const [first, , third] = three;
    if (!first || !third) throw new Error('fixture lost a filter');
    const incoming = inspectionWith([first, third]);

    const result = reconcileMobileState(previous, incoming) as typeof incoming;

    expect(result.servicesReport.filters).toHaveLength(2);
    expect(result.servicesReport.filters[1]).toEqual(third);
  });

  it('does not return `previous` when revisions are equal', () => {
    const previous = inspectionWith(booked);
    const incoming = inspectionWith([...booked, filter('12x12x1', 'Garage', 1, false)]);
    // same updatedAt on both
    expect(incoming.updatedAt).toBe(previous.updatedAt);

    const result = reconcileMobileState(previous, incoming) as typeof incoming;

    expect(result.servicesReport.filters).toHaveLength(3);
  });

  it('survives the real setQueryData path with structuralSharing wired up', () => {
    const client = new QueryClient({
      defaultOptions: { queries: { structuralSharing: reconcileMobileState } },
    });
    const key = ['inspection', 'insp-1'];
    client.setQueryData(key, inspectionWith(booked));

    // exactly what saveServices' mutationFn does
    client.setQueryData(key, (job: any) =>
      job
        ? {
            ...job,
            servicesReport: withAddedFilter(job.servicesReport, {
              size: '12x12x1',
              location: 'Garage',
              slot: 1,
            }),
          }
        : job,
    );

    const after = client.getQueryData<any>(key);
    expect(after.servicesReport.filters).toHaveLength(3);
    expect(filterRows(after.visitDetails, after.servicesReport)).toHaveLength(3);
  });
});

/**
 * The real shape: `technicianInspectionSummarySelect`
 * (backend/src/technician/technician.service.ts:346) selects NEITHER
 * `updatedAt` NOR `version`, so a technician's inspection has no revision.
 */
const realInspectionWith = (filters: ReturnType<typeof filter>[]) => {
  const job = inspectionWith(filters) as Record<string, unknown>;
  delete job.updatedAt;
  return job as ReturnType<typeof inspectionWith>;
};

describe('a VERIFYING guard does not clobber the optimistic write', () => {
  it('a technician inspection has NO revision at all', () => {
    expect(entityRevision(realInspectionWith(booked))).toBeNull();
  });

  it('a guard left by Start job does not replace the added filter with its shadow', () => {
    const serverJob = realInspectionWith(booked); // what `start` returned: 2 filters

    // exactly what `action('PROCESSING', ...)` does for Start job
    const operation = beginIntent('insp-1', 'PROCESSING');
    expect(completeIntent('insp-1', operation, serverJob)).toBe(true);

    // now the technician adds a filter: the optimistic write in saveServices
    const client = new QueryClient({
      defaultOptions: { queries: { structuralSharing: reconcileMobileState } },
    });
    const key = ['inspection', 'insp-1'];
    client.setQueryData(key, serverJob);
    client.setQueryData(key, (job: any) =>
      job
        ? {
            ...job,
            servicesReport: withAddedFilter(job.servicesReport, {
              size: '12x12x1',
              location: 'Garage',
              slot: 1,
            }),
          }
        : job,
    );

    const after = client.getQueryData<any>(key);
    // Three filters go in and three come out.
    //
    // Worth pinning, because this was suspected of causing an added filter to
    // vanish until the app was restarted (2026-09-23) and it turned out not to
    // be the cause -- the real one was the optimistic write sitting inside a
    // scoped `mutationFn`. A guard armed by Start job carries the job as its
    // shadow and its revision is null either way, so anyone reading
    // `applyGuard` will suspect it again; this says plainly that it does not.
    expect(after.servicesReport.filters).toHaveLength(3);
    expect(filterRows(after.visitDetails, after.servicesReport)).toHaveLength(3);

    // and the server's own reply, which `onSuccess` writes, survives too
    const serverReply = realInspectionWith([...booked, filter('12x12x1', 'Garage', 1, false)]);
    client.setQueryData(key, serverReply);
    expect(client.getQueryData<any>(key).servicesReport.filters).toHaveLength(3);
  });

  it('the same guard would have been discarded if the payload carried updatedAt', () => {
    const serverJob = inspectionWith(booked); // HAS updatedAt
    const operation = beginIntent('insp-2', 'PROCESSING');
    completeIntent('insp-2', operation, { ...serverJob, id: 'insp-2' });

    const incoming = {
      ...inspectionWith([...booked, filter('12x12x1', 'Garage', 1, false)]),
      id: 'insp-2',
    };
    const result = reconcileMobileState({ ...serverJob, id: 'insp-2' }, incoming) as any;

    expect(result.servicesReport.filters).toHaveLength(3);
  });
});
