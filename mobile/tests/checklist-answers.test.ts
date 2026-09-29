/**
 * A checklist answer is never taken back (the office, 2026-09-30, on the AC
 * filters checklist): a Y or N "sometimes cleared out by itself as if it is
 * always listens to the server", answered rows "are gone" on coming back, and
 * all of it worse on a slow connection.
 *
 * These drive the real `MutationCache`/`QueryClient` with the options
 * `useRecordChecklistItem` uses, the way `filter-add-mutation-scope.test.ts`
 * drives `saveServices`.
 */
import { MutationCache, QueryCache, QueryClient } from '@tanstack/react-query';

import type { ChecklistAssessment, ChecklistItemWithAssessment } from '../src/domain/models';
import {
  checklistAnswerOptions,
  withPendingAnswers,
  type ChecklistAnswer,
} from '../src/features/checklist-answers';
import { reconcileMobileState } from '../src/features/state-consistency';
import { QueuedOfflineError } from '../src/repositories/api/offline-writes';

const ROOM = 'filters-section';
const key = ['roomChecklist', ROOM];

const row = (id: string): ChecklistItemWithAssessment =>
  ({
    id,
    label: id,
    keywords: [],
    isClean: null,
    isUndamaged: null,
    isWorking: null,
    comment: null,
    numericValue: null,
    textValue: null,
    videoTimestampSeconds: null,
    recordedAt: null,
  }) as ChecklistItemWithAssessment;

const makeClient = () =>
  new QueryClient({
    queryCache: new QueryCache(),
    mutationCache: new MutationCache(),
    defaultOptions: {
      queries: { structuralSharing: reconcileMobileState, retry: false },
      mutations: { retry: false },
    },
  });

const flush = async () => {
  for (let i = 0; i < 12; i += 1) await Promise.resolve();
};

/** A send the test answers by hand, as a slow connection would. */
function slowServer() {
  const sent: { itemId: string; assessment: ChecklistAssessment }[] = [];
  const replies: ((value: unknown) => void)[] = [];
  const send = (itemId: string, assessment: ChecklistAssessment) => {
    sent.push({ itemId, assessment });
    return new Promise((resolve) => replies.push(resolve));
  };
  return { sent, replies, send };
}

const tap = (client: QueryClient, send: ReturnType<typeof slowServer>['send'], answer: ChecklistAnswer, onRefused?: (error: unknown) => void) => {
  const mutation = client
    .getMutationCache()
    .build(client, checklistAnswerOptions({ client, key, roomId: ROOM, send, onRefused }));
  void mutation.execute(answer).catch(() => undefined);
  return mutation;
};

const drawn = (client: QueryClient, id: string) =>
  client.getQueryData<ChecklistItemWithAssessment[]>(key)?.find((item) => item.id === id);

describe('a Y or N tapped on the checklist', () => {
  it('is drawn at once and stays, however slowly the server answers', async () => {
    const client = makeClient();
    client.setQueryData(key, [row('filter-a'), row('filter-b')]);
    const server = slowServer();

    tap(client, server.send, { itemId: 'filter-a', patch: { isClean: true } });
    tap(client, server.send, { itemId: 'filter-b', patch: { isClean: false } });
    await flush();
    expect(drawn(client, 'filter-a')?.isClean).toBe(true);
    expect(drawn(client, 'filter-b')?.isClean).toBe(false);

    // The first reply lands, long after -- and changes nothing on screen.
    server.replies[0]?.(undefined);
    await flush();
    expect(drawn(client, 'filter-b')?.isClean).toBe(false);
    server.replies[1]?.(undefined);
    await flush();
    expect(drawn(client, 'filter-a')?.isClean).toBe(true);
    expect(drawn(client, 'filter-b')?.isClean).toBe(false);
  });

  it('keeps both of two quick taps on one row: the second send carries the first', async () => {
    const client = makeClient();
    client.setQueryData(key, [row('filter-a')]);
    const server = slowServer();

    tap(client, server.send, { itemId: 'filter-a', patch: { isClean: true } });
    tap(client, server.send, { itemId: 'filter-a', patch: { isWorking: false } });
    await flush();
    // One at a time: the second waits for the first.
    expect(server.sent).toHaveLength(1);

    server.replies[0]?.(undefined);
    await flush();
    expect(server.sent).toHaveLength(2);
    // What the server is told last is the whole row, both taps in it.
    expect(server.sent[1]?.assessment).toMatchObject({ isClean: true, isWorking: false });
    server.replies[1]?.(undefined);
    await flush();
  });

  it('stays drawn when it is held on the phone for want of signal', async () => {
    const client = makeClient();
    client.setQueryData(key, [row('filter-a')]);
    const refused = jest.fn();

    tap(client, async () => {
      throw new QueuedOfflineError('offline');
    }, { itemId: 'filter-a', patch: { isUndamaged: true } }, refused);
    await flush();

    expect(drawn(client, 'filter-a')?.isUndamaged).toBe(true);
    expect(refused).not.toHaveBeenCalled();
  });

  it('says so when the server refuses it, rather than vanishing without a word', async () => {
    const client = makeClient();
    client.setQueryData(key, [row('filter-a')]);
    const refused = jest.fn();

    tap(client, async () => {
      throw new Error('The checklist cannot be changed after the inspection is finalized.');
    }, { itemId: 'filter-a', patch: { isUndamaged: true } }, refused);
    await flush();

    expect(refused).toHaveBeenCalledTimes(1);
  });
});

describe('the checklist read while answers are still being sent', () => {
  it('lays every pending answer over the server’s copy, in the order tapped', async () => {
    const client = makeClient();
    client.setQueryData(key, [row('filter-a'), row('filter-b')]);
    const server = slowServer();

    tap(client, server.send, { itemId: 'filter-a', patch: { isClean: true } });
    tap(client, server.send, { itemId: 'filter-a', patch: { isClean: false } });
    tap(client, server.send, { itemId: 'filter-b', patch: { isWorking: true } });
    await flush();

    // The server has none of them yet: a refresh or a return to the screen.
    const read = withPendingAnswers(client, ROOM, [row('filter-a'), row('filter-b')]);
    expect(read.find((item) => item.id === 'filter-a')?.isClean).toBe(false);
    expect(read.find((item) => item.id === 'filter-b')?.isWorking).toBe(true);
  });

  it('is the server’s copy alone once nothing is pending', () => {
    const client = makeClient();
    expect(withPendingAnswers(client, ROOM, [row('filter-a')])).toEqual([row('filter-a')]);
  });
});
