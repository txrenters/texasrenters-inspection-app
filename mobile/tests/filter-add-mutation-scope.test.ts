/**
 * An answer must draw at once even while an earlier one is still sending.
 *
 * `saveServices` carries `scope: { id: 'job-services:<id>' }` so two answers to
 * one job cannot be in flight together. The gate sits AFTER `onMutate` and
 * BEFORE `mutationFn`: query-core awaits `onMutate`, then `retryer.start()`
 * calls `pause()` rather than `run()` while another mutation in the scope is
 * pending. The comment in `queries.ts` used to claim a scoped mutation "runs
 * both at execute time", which is simply not true.
 *
 * So with the optimistic write inside `mutationFn`, photographing a filter and
 * then answering another register before the PATCH returned drew nothing until
 * the first settled. The office has asked four separate times for every control
 * to respond instantly, so that is a defect on its own terms.
 *
 * **This is NOT the cause of the 2026-09-23 "added filter only appears after a
 * restart" report** -- that was the VERIFYING guard, see reconcile-filters.test.ts.
 * It cannot have been: a paused mutation never sends, and
 * `shouldDehydrateMutation: () => false` discards it on restart with nothing
 * calling `resumePausedMutations`, so the filter would have been lost for good
 * rather than revealed. It was found while diagnosing that one.
 *
 * These drive the real `MutationCache`/`QueryClient` against a mutation built
 * the way `useInspectionActions` builds it. Keep them in step with
 * `saveServices`: the shape being guarded is "the write is in `onMutate`, the
 * send is in `mutationFn`".
 */
import { MutationCache, QueryCache, QueryClient } from '@tanstack/react-query';

import { reconcileMobileState } from '../src/features/state-consistency';
import { filterRows, withAddedFilter, withFilterAnswer } from '../src/utils/job-tasks';

const key = ['inspection', 'job-1'];
const visitDetails = 'Filter Change: 20x25x1';
const scope = { id: 'job-services:job-1' };
const photoAnswer = { size: '20x25x1', location: null, slot: 1 };
const addedFilter = { size: '16x20x1', location: 'Attic', slot: 1 };

const makeClient = () =>
  new QueryClient({
    queryCache: new QueryCache(),
    mutationCache: new MutationCache(),
    defaultOptions: {
      queries: { structuralSharing: reconcileMobileState, retry: false },
      mutations: { retry: false },
    },
  });

/**
 * `saveServices` as `useInspectionActions` builds it.
 *
 * The write is in `onMutate` and the send is in `mutationFn`, which reads the
 * cache `onMutate` just wrote. `mutationFn` cannot be handed `onMutate`'s
 * return value -- in v5 its second argument carries only
 * `{client, meta, mutationKey}` -- so the cache is the accumulator, and each
 * queued tap applies its updater on top of the one before it.
 */
const buildSaveServices = (
  client: QueryClient,
  send: (report: unknown) => Promise<unknown>,
  marks?: { onMutationFnEntered?: () => void },
) =>
  client.getMutationCache().build(client, {
    scope,
    onMutate: async (update: unknown) => {
      await client.cancelQueries({ queryKey: key });
      const current = client.getQueryData<any>(key)?.servicesReport ?? null;
      const servicesReport = typeof update === 'function' ? update(current) : update;
      client.setQueryData(key, (job?: any) => (job ? { ...job, servicesReport } : job));
    },
    mutationFn: async () => {
      marks?.onMutationFnEntered?.();
      return send(client.getQueryData<any>(key)?.servicesReport ?? null);
    },
    onSuccess: (inspection: unknown) => {
      client.setQueryData(key, inspection);
    },
  });

/** The server echoing the report back inside the job, as `savedServicesSchema` does. */
const echo = async (servicesReport: unknown) => ({ id: 'job-1', visitDetails, servicesReport });

const rowsNow = (client: QueryClient) => {
  const job = client.getQueryData<any>(key);
  return filterRows(job?.visitDetails, job?.servicesReport);
};

const flush = async () => {
  for (let i = 0; i < 12; i += 1) await Promise.resolve();
};

const seed = (client: QueryClient) =>
  client.setQueryData(key, { id: 'job-1', visitDetails, servicesReport: null });

const photographFilter = (current: unknown) =>
  withFilterAnswer(current as never, photoAnswer, { changed: true, photoKey: 'snap-1' });

const addFilter = (current: unknown) => withAddedFilter(current as never, addedFilter);

describe('an added filter appears while an earlier answer is still sending', () => {
  it('draws the new row before the scope releases', async () => {
    const client = makeClient();
    seed(client);
    expect(rowsNow(client)).toHaveLength(1); // the one register the visit booked

    // The photograph the technician just took, still in flight.
    let settlePhoto: (value: unknown) => void = () => undefined;
    const photo = buildSaveServices(client, () => new Promise((resolve) => (settlePhoto = resolve)));
    void photo.execute(photographFilter);
    await flush();
    expect(photo.state.status).toBe('pending');

    // They tap Add while it is still sending.
    let addEnteredMutationFn = false;
    const add = buildSaveServices(client, echo, {
      onMutationFnEntered: () => (addEnteredMutationFn = true),
    });
    void add.execute(addFilter);
    await flush();

    // The send is still gated behind the photograph -- that is the scope doing
    // its job, and it must stay that way.
    expect(addEnteredMutationFn).toBe(false);
    expect(add.state.isPaused).toBe(true);

    // But the row is already on screen. This is the whole fix.
    expect(rowsNow(client)).toHaveLength(2);

    settlePhoto(await echo(client.getQueryData<any>(key)?.servicesReport));
    await flush();
    expect(addEnteredMutationFn).toBe(true);
    expect(rowsNow(client)).toHaveLength(2);
  });

  it('a queued second answer still builds on the first rather than replacing it', async () => {
    const client = makeClient();
    seed(client);

    let settlePhoto: (value: unknown) => void = () => undefined;
    const photo = buildSaveServices(client, () => new Promise((resolve) => (settlePhoto = resolve)));
    void photo.execute(photographFilter);
    await flush();

    const add = buildSaveServices(client, echo);
    void add.execute(addFilter);
    await flush();
    settlePhoto(await echo(client.getQueryData<any>(key)?.servicesReport));
    await flush();

    // Two answers, both kept: the photographed register and the added one. The
    // scope plus a cache-accumulating updater is what stops the second tap
    // sending the report as it was before the first.
    const report = client.getQueryData<any>(key)?.servicesReport;
    expect(report.filters).toHaveLength(2);
    expect(report.filters.find((entry: any) => entry.size === '20x25x1').photoKey).toBe('snap-1');
    expect(report.filters.find((entry: any) => entry.size === '16x20x1')).toBeTruthy();
  });

  it('a mutation whose observer unmounted still settles and releases the scope', async () => {
    // The camera calls `goBack()` straight after firing its answer, so the
    // mutation outlives the screen that started it. If that did not settle,
    // every later Add on this job would stay paused for the life of the app.
    const client = makeClient();
    seed(client);

    let settlePhoto: (value: unknown) => void = () => undefined;
    const photo = buildSaveServices(client, () => new Promise((resolve) => (settlePhoto = resolve)));
    void photo.execute(photographFilter);
    await flush();

    const add = buildSaveServices(client, echo);
    void add.execute(addFilter);
    await flush();
    expect(rowsNow(client)).toHaveLength(2);

    settlePhoto(await echo(client.getQueryData<any>(key)?.servicesReport));
    await flush();
    expect(add.state.isPaused).toBe(false);
    expect(rowsNow(client)).toHaveLength(2);
  });
});
