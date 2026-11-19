import { phoneCountProblem, readPhoneCount, type PhoneCountLine } from '@texasrenters/shared';

import { QueuedOfflineError, TRUCK_COUNT_KIND, drainOfflineWrites, savedTruckCount, sendSavedFirst, truckCountEntryId } from '../src/repositories/api/offline-writes';
import { truckCountSavedSchema, truckCountsSchema } from '../src/repositories/api/truck-counts-schema';
import { dismissCountRefusal, readCountRefusals } from '../src/storage/count-refusals';
import { readQueue } from '../src/storage/mutation-queue';
import { ApiConnectionError, ApiRefusalError } from '../src/storage/offline-record-cache';
import { useNetworkStore } from '../src/stores/network.store';
import { countCardLine, countLines, countName, countProgress, countedLines, scannedCountLine, withCount, type PendingCount } from '../src/utils/truck-count';

/**
 * Counting a truck on the phone (2026-11-19). Every item, truck and count
 * here is invented.
 *
 * Exercised as rules and as the queue, not through a renderer, as the rest of
 * these tests are: what the screen shows while numbers are still on the
 * phone, that a count survives no signal and the app being closed, that a
 * newer save replaces the older, and that one the office later refuses is
 * said and not dropped.
 */

// Prefixed `mock` so jest permits the hoisted factory below to reference it.
const mockStore = new Map<string, string>();

jest.mock('../src/storage/demo-storage', () => ({
  demoStorage: {
    getItem: async (key: string) => mockStore.get(key) ?? null,
    setItem: async (key: string, value: string) => {
      mockStore.set(key, value);
    },
    removeItem: async (key: string) => {
      mockStore.delete(key);
    },
  },
}));

jest.mock('../src/media/room-snapshot-flush', () => ({
  flushRoomSnapshotsNow: async () => undefined,
}));

const line = (over: Partial<PhoneCountLine> = {}): PhoneCountLine => ({ lineId: 'line-filter', itemId: 'item-filter', code: 'FLT-0003', name: 'Filter 20x25x1', unit: 'each', counted: null, second: false, ...over });
const battery = (over: Partial<PhoneCountLine> = {}) => line({ lineId: 'line-battery', itemId: 'item-battery', code: 'PRT-0001', name: 'Battery, 9 V', ...over });
const LINES = [line(), battery()];
const pending = (over: Partial<PendingCount> = {}): PendingCount => ({
  countId: 'count-1',
  title: 'Monthly count, November 2026 · Truck 1',
  lines: [{ lineId: 'line-filter', counted: 8, second: false }],
  handIn: false,
  queuedAt: '2026-11-19T15:00:00.000Z',
  ...over,
});
const entryFor = (one: PendingCount) => ({ id: truckCountEntryId(one.countId), kind: TRUCK_COUNT_KIND, payload: { ...one } });
const offline = async () => {
  throw new ApiConnectionError('cannot connect', 'transport');
};

beforeEach(() => {
  mockStore.clear();
  useNetworkStore.setState({ isOnline: true, isResolved: true });
});

describe('what the count shows', () => {
  it('lays the numbers this phone is holding over what the server sent', () => {
    expect(countLines(LINES, null)).toEqual(LINES);
    expect(countLines(LINES, pending())).toEqual([line({ counted: 8 }), battery()]);
  });

  it('never takes a first count held on the phone as the second count of a line that came back', () => {
    const cameBack = [line({ second: true })];
    expect(countLines(cameBack, pending())).toEqual(cameBack);
    expect(countLines(cameBack, pending({ lines: [{ lineId: 'line-filter', counted: 7, second: true }] }))).toEqual([line({ second: true, counted: 7 })]);
  });

  it('sends every line that has a number, each saying which count of the line it is', () => {
    const counted = withCount(withCount(LINES, 'line-filter', 8), 'line-battery', 0);
    expect(countedLines(counted)).toEqual([
      { lineId: 'line-filter', counted: 8, second: false },
      // Nothing there is a count too: zero is sent, not left out.
      { lineId: 'line-battery', counted: 0, second: false },
    ]);
    expect(countedLines(LINES)).toEqual([]);
  });

  it('says how far along it is, and what is left on the home card', () => {
    expect(countProgress(withCount(LINES, 'line-filter', 8))).toBe('1 of 2 counted');
    expect(countCardLine({ lines: LINES }, null)).toBe('2 items to count');
    expect(countCardLine({ lines: LINES }, pending())).toBe('1 item to count');
    expect(countCardLine({ lines: [line({ second: true })] }, null)).toBe('1 item to count a second time');
    expect(countCardLine({ lines: [line({ counted: 8 })] }, null)).toBe('Every item is counted. Hand it in.');
    expect(countCardLine({ lines: LINES }, pending({ handIn: true }))).toBe('Handed in · waiting to send');
    expect(countName({ title: 'Monthly count, November 2026', place: { id: 'truck-1', name: 'Truck 1' } })).toBe('Monthly count, November 2026 · Truck 1');
  });
});

describe('scanning and typing', () => {
  it('finds the line a label names, as a scanner or a hand might give it', () => {
    expect(scannedCountLine(LINES, ' prt-0001 ')).toEqual({ line: battery() });
    expect(scannedCountLine(LINES, 'XYZ-999')).toEqual({ said: 'XYZ-999 is not in this count.' });
    // Something that is not a label at all is not read back in full.
    expect(scannedCountLine(LINES, 'https://example.com/a-very-long-address-on-a-box')).toEqual({ said: 'HTTPS://EXAMPLE.COM/A-VE is not in this count.' });
  });

  it('reads a whole number of units, zero included, and nothing else', () => {
    expect(readPhoneCount(' 8 ')).toBe(8);
    expect(readPhoneCount('0')).toBe(0);
    for (const typed of ['', 'eight', '1.5', '-1', '99999999']) expect(readPhoneCount(typed)).toBeNull();
  });

  it('can be handed in only when every item has a number', () => {
    expect(phoneCountProblem(LINES)).toBe('2 items are not counted yet.');
    expect(phoneCountProblem([line({ counted: 8 }), battery()])).toBe('1 item is not counted yet.');
    expect(phoneCountProblem([line({ counted: 8 }), battery({ counted: 0 })])).toBeNull();
  });
});

describe('what the server answers', () => {
  const reply = { counts: [{ id: 'count-1', number: 'CNT-0013', title: 'Monthly count, November 2026', place: { id: 'truck-1', name: 'Truck 1' }, lines: LINES }] };

  it('is kept whole: every field the screen reads is named, and it survives being stored and read back', () => {
    const parsed = truckCountsSchema.parse(reply);
    expect(parsed).toEqual(reply);
    expect(truckCountsSchema.parse(JSON.parse(JSON.stringify(parsed)))).toEqual(reply);
    expect(truckCountSavedSchema.parse({ ...reply, outcome: 'recount', recounts: 1 })).toEqual({ ...reply, outcome: 'recount', recounts: 1 });
  });

  it('is refused when it is not a list of counts, so a wrong reply is never shown as nothing to count', () => {
    expect(truckCountsSchema.safeParse({}).success).toBe(false);
    expect(truckCountSavedSchema.safeParse({ ...reply, outcome: 'posted', recounts: 0 }).success).toBe(false);
  });
});

describe('a count typed on the phone', () => {
  it('is on the phone while the request is still out, which is when the app gets closed', async () => {
    let answer: (value: unknown) => void = () => undefined;
    const sent = sendSavedFirst(entryFor(pending()), () => new Promise((resolve) => (answer = resolve)));
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(await savedTruckCount('count-1')).toMatchObject({ countId: 'count-1', handIn: false, lines: [{ lineId: 'line-filter', counted: 8, second: false }] });
    // Another count's screen does not show it.
    expect(await savedTruckCount('count-2')).toBeNull();
    answer({});
    await sent;
    expect(await savedTruckCount('count-1')).toBeNull();
  });

  it('keeps one entry a count with no signal: a newer save carries every number and replaces the older', async () => {
    await expect(sendSavedFirst(entryFor(pending()), offline)).rejects.toBeInstanceOf(QueuedOfflineError);
    const both = [
      { lineId: 'line-filter', counted: 8, second: false },
      { lineId: 'line-battery', counted: 5, second: false },
    ];
    await expect(sendSavedFirst(entryFor(pending({ lines: both, handIn: true })), offline)).rejects.toBeInstanceOf(QueuedOfflineError);
    expect(await readQueue()).toHaveLength(1);
    expect(await savedTruckCount('count-1')).toMatchObject({ lines: both, handIn: true });
  });

  it('is sent when the signal is back, with only the lines and whether it is handed in', async () => {
    await expect(sendSavedFirst(entryFor(pending({ handIn: true })), offline)).rejects.toBeInstanceOf(QueuedOfflineError);
    const calls: { path: string; method: string; body: unknown }[] = [];
    const result = await drainOfflineWrites(async (path, method, body) => {
      calls.push({ path, method, body });
      return {};
    });
    expect(result).toEqual({ sent: 1, remaining: 0 });
    // No title, no truck, no counter: the server decides whose count it is.
    expect(calls).toEqual([{ path: '/api/v1/technician/stock-counts/count-1', method: 'POST', body: { lines: [{ lineId: 'line-filter', counted: 8, second: false }], handIn: true } }]);
    expect(await readQueue()).toEqual([]);
    expect(await readCountRefusals()).toEqual([]);
  });

  it('is said, not dropped, when the office refuses it later: the reason is kept until it is read', async () => {
    await expect(sendSavedFirst(entryFor(pending({ handIn: true })), offline)).rejects.toBeInstanceOf(QueuedOfflineError);
    await drainOfflineWrites(async () => {
      throw new ApiRefusalError('The office cancelled that count.', 409, 'STOCK_COUNT_NOT_COUNTING');
    });
    expect(await readQueue()).toEqual([]);
    expect(await readCountRefusals()).toEqual([{ countId: 'count-1', title: 'Monthly count, November 2026 · Truck 1', reason: 'The office cancelled that count.', at: expect.any(String) }]);
    await dismissCountRefusal('count-1');
    expect(await readCountRefusals()).toEqual([]);
  });

  it('is kept for another go, and nothing is said, while the server still cannot be reached', async () => {
    await expect(sendSavedFirst(entryFor(pending()), offline)).rejects.toBeInstanceOf(QueuedOfflineError);
    await drainOfflineWrites(async () => {
      throw new ApiConnectionError('still nothing', 'unavailable');
    });
    expect(await savedTruckCount('count-1')).not.toBeNull();
    expect(await readCountRefusals()).toEqual([]);
  });
});
