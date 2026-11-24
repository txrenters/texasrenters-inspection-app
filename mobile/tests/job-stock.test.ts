import type { JobStock, JobStockItem } from '@texasrenters/shared';

import { jobStockSchema } from '../src/repositories/api/job-stock-schema';
import { JOB_STOCK_KIND, QueuedOfflineError, drainOfflineWrites, jobStockEntryId, savedJobStockSlips, sendSavedFirst } from '../src/repositories/api/offline-writes';
import { readQueue } from '../src/storage/mutation-queue';
import { ApiConnectionError, ApiRefusalError } from '../src/storage/offline-record-cache';
import { dismissStockRefusal, readStockRefusals } from '../src/storage/stock-refusals';
import { useNetworkStore } from '../src/stores/network.store';
import { SAME_LABEL_PAUSE_MS, acceptScan, scanOntoSlip } from '../src/utils/item-scan';
import { materialsLine, newSlipKey, showsMaterials, slipLines, slipSummary, stepped, takenForJob, takenFromTruck, truckStock, type PendingSlip } from '../src/utils/job-stock';

/**
 * A job's materials on the phone (2026-11-19, phase 7). Every item, truck and
 * job here is invented.
 *
 * Exercised as rules and as the queue, not through a renderer, as the rest of
 * these tests are: what the truck shows while a slip is still on the phone,
 * that a slip survives no signal and the app being closed, that it is sent
 * once, and that one the server later refuses is said and not dropped.
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

const filter = (quantity: number): JobStockItem => ({ itemId: 'item-filter', code: 'FLT-0003', name: 'Filter 20x25x1', unit: 'each', quantity });
const battery = (quantity: number): JobStockItem => ({ itemId: 'item-battery', code: 'PRT-0001', name: 'Battery, 9 V', unit: 'each', quantity });
const STOCK: JobStock['stock'] = [
  { ...filter(10), placeId: 'truck-1' },
  { ...battery(6), placeId: 'truck-1' },
  { ...filter(3), placeId: 'truck-2' },
];
const slip = (over: Partial<PendingSlip> = {}): PendingSlip => ({
  inspectionId: 'job-1',
  kind: 'WITHDRAWAL',
  placeId: 'truck-1',
  lines: [{ itemId: 'item-filter', quantity: 2 }],
  named: [filter(2)],
  clientRequestId: 'slip-key-0001',
  queuedAt: '2026-11-19T15:00:00.000Z',
  ...over,
});
const entryFor = (one: PendingSlip) => ({ id: jobStockEntryId(one.clientRequestId), kind: JOB_STOCK_KIND, payload: { ...one } });

beforeEach(() => {
  mockStore.clear();
  useNetworkStore.setState({ isOnline: true, isResolved: true });
});

describe('what the truck shows', () => {
  it('is what the office has in that truck, by code', () => {
    expect(truckStock(STOCK, 'truck-1', [])).toEqual([filter(10), battery(6)]);
    expect(truckStock(STOCK, 'truck-2', [])).toEqual([filter(3)]);
    expect(truckStock(STOCK, 'no-such-truck', [])).toEqual([]);
  });

  it('already counts what this phone has taken and not yet sent, so nothing is taken twice', () => {
    expect(truckStock(STOCK, 'truck-1', [slip()])).toEqual([filter(8), battery(6)]);
    // The last ones are gone from the list, not offered at nothing.
    expect(truckStock(STOCK, 'truck-2', [slip({ placeId: 'truck-2', named: [filter(3)] })])).toEqual([]);
    // A slip for another truck leaves this one alone; a return still on the phone is back on the shelf.
    expect(truckStock(STOCK, 'truck-1', [slip({ placeId: 'truck-2' }), slip({ kind: 'RETURN', named: [battery(1)], clientRequestId: 'slip-key-0002' })])).toEqual([filter(10), battery(7)]);
  });

  it('counts what can go back the same way: what was taken, with what the phone is holding', () => {
    expect(takenForJob([filter(2)], [])).toEqual([filter(2)]);
    expect(takenForJob([filter(2)], [slip({ named: [battery(1)] })])).toEqual([filter(2), battery(1)]);
    expect(takenForJob([filter(2)], [slip({ kind: 'RETURN', named: [filter(2)] })])).toEqual([]);
  });
});

describe('the steppers', () => {
  it('go up to what there is and down to nothing', () => {
    expect(stepped({}, 'item-filter', 1, 2)).toEqual({ 'item-filter': 1 });
    expect(stepped({ 'item-filter': 2 }, 'item-filter', 1, 2)).toEqual({ 'item-filter': 2 });
    expect(stepped({ 'item-filter': 0 }, 'item-filter', -1, 2)).toEqual({ 'item-filter': 0 });
  });

  it('make a slip of only what was asked for, named as the screen showed it', () => {
    expect(slipLines([filter(10), battery(6)], { 'item-battery': 2, 'item-filter': 0 })).toEqual({ lines: [{ itemId: 'item-battery', quantity: 2 }], named: [battery(2)] });
    expect(slipLines([filter(10)], {})).toEqual({ lines: [], named: [] });
    expect(slipSummary([filter(2), battery(1)])).toBe('2 × Filter 20x25x1, 1 × Battery, 9 V');
  });

  it('give each slip a key of its own, in the letters the server takes', () => {
    const keys = new Set(Array.from({ length: 200 }, () => newSlipKey()));
    expect(keys.size).toBe(200);
    for (const key of keys) expect(key).toMatch(/^[A-Za-z0-9_-]{8,128}$/);
  });
});

describe('scanning a label (2026-11-19)', () => {
  const OFFERED = [filter(2), battery(6)];

  // 2026-11-24: with every item in use known, a code that is no item is said apart from one not in the truck.
  it('says a code that is no item apart from an item that is not in this truck', () => {
    const known = { catalog: [{ itemId: 'item-alarm', code: 'SMK-0010', name: 'Smoke alarm', unit: 'each' }, { itemId: 'item-filter', code: 'FLT-0003', name: 'Filter 20x25x1', unit: 'each' }], placeName: 'Truck 1' };
    expect(scanOntoSlip(OFFERED, {}, 'SMK-0010', 'WITHDRAWAL', known).said).toEqual({ words: 'SMK-0010 is not in Truck 1.', bad: true });
    expect(scanOntoSlip(OFFERED, {}, 'XYZ-999', 'WITHDRAWAL', known).said).toEqual({ words: 'XYZ-999 is not an item code. Check the label, or type it.', bad: true });
    expect(scanOntoSlip(OFFERED, {}, 'SMK-0010', 'RETURN', known).said.words).toBe('SMK-0010 was not taken from Truck 1 for this job.');
  });

  it('is one more of that item, exactly as a tap on + is', () => {
    const first = scanOntoSlip(OFFERED, {}, 'FLT-0003', 'WITHDRAWAL');
    expect(first).toEqual({ quantities: { 'item-filter': 1 }, said: { words: 'FLT-0003 · Filter 20x25x1: 1 taken. 1 left. Move the label away and back for one more.', bad: false } });
    // The label's letters as a scanner or a hand might give them.
    expect(scanOntoSlip(OFFERED, first.quantities, ' flt-0003 ', 'WITHDRAWAL').quantities).toEqual({ 'item-filter': 2 });
  });

  it('stops at what the truck holds, and says so', () => {
    const full = scanOntoSlip(OFFERED, { 'item-filter': 2 }, 'FLT-0003', 'WITHDRAWAL');
    expect(full.quantities).toEqual({ 'item-filter': 2 });
    expect(full.said).toEqual({ words: 'That is all 2 of Filter 20x25x1 in the truck.', bad: true });
    expect(scanOntoSlip(OFFERED, { 'item-filter': 2 }, 'FLT-0003', 'RETURN').said.words).toBe('That is all 2 of Filter 20x25x1 taken.');
  });

  it('adds nothing for a label that is not in this truck, or not taken for this job', () => {
    expect(scanOntoSlip(OFFERED, { 'item-battery': 1 }, 'XYZ-999', 'WITHDRAWAL')).toEqual({ quantities: { 'item-battery': 1 }, said: { words: 'XYZ-999 is not in this truck.', bad: true } });
    expect(scanOntoSlip(OFFERED, {}, 'XYZ-999', 'RETURN').said.words).toBe('XYZ-999 was not taken for this job.');
    // Something that is not a label at all is not read back in full.
    expect(scanOntoSlip(OFFERED, {}, 'https://example.com/a-very-long-address-on-a-box', 'WITHDRAWAL').said.words).toBe('HTTPS://EXAMPLE.COM/A-VE is not in this truck.');
  });

  /** The camera's reads of whatever is in view, ten a second from `from` for `ms`: what it hands the scanner. */
  const reads = (codes: string[], from: number, ms: number) =>
    Array.from({ length: ms / 100 }, (_, index) => ({ code: codes[index % codes.length]!, at: from + index * 100 }));
  const counted = (seen: Map<string, number>, frames: { code: string; at: number }[]) => frames.filter((frame) => acceptScan(seen, frame.code, frame.at)).map((frame) => frame.code);

  it('counts a label held in view once, however long it is held', () => {
    // Five seconds on one filter label used to record four filters: it counted again every pause.
    expect(counted(new Map(), reads(['FLT-0003'], 1_000, 5_000))).toEqual(['FLT-0003']);
  });

  it('counts two labels in view at once once each, not on every read', () => {
    // Read in turn, each read was "another label" and both counted ten times a second.
    expect(counted(new Map(), reads(['FLT-0003', 'PRT-0001'], 1_000, 3_000))).toEqual(['FLT-0003', 'PRT-0001']);
  });

  it('counts the same label again once it has been out of view for the pause', () => {
    const seen = new Map<string, number>();
    expect(acceptScan(seen, 'FLT-0003', 1_000)).toBe(true);
    // Taken away and shown again too soon: the same scan.
    expect(acceptScan(seen, 'flt-0003', 1_000 + SAME_LABEL_PAUSE_MS - 1)).toBe(false);
    // Out of view for the whole pause since it was last seen: one more.
    expect(acceptScan(seen, 'FLT-0003', 1_000 + 2 * SAME_LABEL_PAUSE_MS)).toBe(true);
    // Another label straight after is its own scan; a blank read is nothing.
    expect(acceptScan(seen, 'PRT-0001', 1_000 + 2 * SAME_LABEL_PAUSE_MS + 1)).toBe(true);
    expect(acceptScan(seen, '  ', 9_999)).toBe(false);
  });
});

describe('the job screen\'s Materials row', () => {
  it('is there only where the office keeps a truck for this technician, or something was recorded', () => {
    expect(showsMaterials(undefined, [], [])).toBe(false);
    expect(showsMaterials({ places: [], slips: [] }, [], [])).toBe(false);
    expect(showsMaterials({ places: [{ id: 'truck-1', name: 'Truck 1' }], slips: [] }, [], [])).toBe(true);
    expect(showsMaterials({ places: [], slips: [] }, [slip()], [])).toBe(true);
  });

  it('says what the job has used, and what is still waiting to send', () => {
    expect(materialsLine([], 0)).toBe('Nothing taken for this job yet');
    expect(materialsLine([filter(1)], 0)).toBe('1 item taken for this job');
    expect(materialsLine([filter(2), battery(1)], 1)).toBe('3 items taken for this job · 1 waiting to send');
  });
});

describe('what the server answers', () => {
  const reply: JobStock = {
    places: [{ id: 'truck-1', name: 'Truck 1' }],
    stock: STOCK,
    slips: [{ id: 'slip-1', number: 'WD-0031', kind: 'WITHDRAWAL', at: '2026-11-19T15:00:00.000Z', place: 'Truck 1', placeId: 'truck-1', reversed: false, lines: [filter(2)] }],
    taken: [filter(2)],
    catalog: [{ itemId: 'item-alarm', code: 'SMK-0010', name: 'Smoke alarm', unit: 'each' }],
  };

  it('is kept whole: every field the screen reads is named, and it survives being stored and read back', () => {
    const parsed = jobStockSchema.parse(reply);
    expect(parsed).toEqual(reply);
    expect(jobStockSchema.parse(JSON.parse(JSON.stringify(parsed)))).toEqual(reply);
  });

  it('is refused when it is not a job\'s materials, so a wrong reply is never shown as an empty truck', () => {
    expect(jobStockSchema.safeParse({ places: [] }).success).toBe(false);
    expect(jobStockSchema.safeParse({ ...reply, slips: [{ ...reply.slips[0], kind: 'TRANSFER' }] }).success).toBe(false);
  });
});

describe('a slip recorded on the phone', () => {
  it('is on the phone while the request is still out, which is when the app gets closed', async () => {
    let answer: (value: unknown) => void = () => undefined;
    const sent = sendSavedFirst(entryFor(slip()), () => new Promise((resolve) => (answer = resolve)));
    await new Promise((resolve) => setTimeout(resolve, 0));

    expect(await savedJobStockSlips('job-1')).toEqual([expect.objectContaining({ clientRequestId: 'slip-key-0001', kind: 'WITHDRAWAL', named: [filter(2)] })]);
    // Another job's screen does not show it.
    expect(await savedJobStockSlips('job-2')).toEqual([]);

    answer({});
    await sent;
    expect(await savedJobStockSlips('job-1')).toEqual([]);
  });

  it('stays, one entry a slip, when there is no signal: a second slip never replaces the first', async () => {
    const offline = async () => {
      throw new ApiConnectionError('cannot connect', 'transport');
    };
    await expect(sendSavedFirst(entryFor(slip()), offline)).rejects.toBeInstanceOf(QueuedOfflineError);
    await expect(sendSavedFirst(entryFor(slip({ clientRequestId: 'slip-key-0002', named: [battery(1)], lines: [{ itemId: 'item-battery', quantity: 1 }] })), offline)).rejects.toBeInstanceOf(QueuedOfflineError);
    expect((await savedJobStockSlips('job-1')).map((one) => one.clientRequestId)).toEqual(['slip-key-0001', 'slip-key-0002']);
  });

  it('is sent when the signal is back, with its own key and nothing about who or what it cost', async () => {
    await expect(
      sendSavedFirst(entryFor(slip()), async () => {
        throw new ApiConnectionError('cannot connect', 'transport');
      }),
    ).rejects.toBeInstanceOf(QueuedOfflineError);

    const calls: { path: string; method: string; body: unknown }[] = [];
    const result = await drainOfflineWrites(async (path, method, body) => {
      calls.push({ path, method, body });
      return {};
    });
    expect(result).toEqual({ sent: 1, remaining: 0 });
    expect(calls).toEqual([
      { path: '/api/v1/technician/inspections/job-1/stock', method: 'POST', body: { kind: 'WITHDRAWAL', placeId: 'truck-1', lines: [{ itemId: 'item-filter', quantity: 2 }], clientRequestId: 'slip-key-0001' } },
    ]);
    expect(await readQueue()).toEqual([]);
    expect(await readStockRefusals()).toEqual([]);
  });

  it('is said, not dropped, when the office\'s numbers refuse it later: the reason is kept until it is read', async () => {
    await expect(
      sendSavedFirst(entryFor(slip()), async () => {
        throw new ApiConnectionError('cannot connect', 'transport');
      }),
    ).rejects.toBeInstanceOf(QueuedOfflineError);

    await drainOfflineWrites(async () => {
      throw new ApiRefusalError('Only 1 of FLT-0003 is there.', 409, 'STOCK_SLIP_NOT_READY');
    });
    // Out of the queue: it will never be accepted as it is.
    expect(await readQueue()).toEqual([]);
    const refusals = await readStockRefusals();
    expect(refusals).toEqual([{ clientRequestId: 'slip-key-0001', inspectionId: 'job-1', kind: 'WITHDRAWAL', named: [filter(2)], reason: 'Only 1 of FLT-0003 is there.', at: expect.any(String) }]);

    await dismissStockRefusal('slip-key-0001');
    expect(await readStockRefusals()).toEqual([]);
  });

  it('is kept for another go, and nothing is said, while the server still cannot be reached', async () => {
    await expect(
      sendSavedFirst(entryFor(slip()), async () => {
        throw new ApiConnectionError('cannot connect', 'transport');
      }),
    ).rejects.toBeInstanceOf(QueuedOfflineError);
    await drainOfflineWrites(async () => {
      throw new ApiConnectionError('still nothing', 'unavailable');
    });
    expect((await savedJobStockSlips('job-1')).map((one) => one.clientRequestId)).toEqual(['slip-key-0001']);
    expect(await readStockRefusals()).toEqual([]);
  });

  it('is refused at once, and not kept, when the server says no while the technician is looking', async () => {
    await expect(
      sendSavedFirst(entryFor(slip()), async () => {
        throw new ApiRefusalError('Only 1 of FLT-0003 is there.', 409, 'STOCK_SLIP_NOT_READY');
      }),
    ).rejects.toMatchObject({ message: 'Only 1 of FLT-0003 is there.' });
    expect(await readQueue()).toEqual([]);
    // The screen has just said why: nothing is left to read later.
    expect(await readStockRefusals()).toEqual([]);
  });
});

describe('a copy kept before every item in use came with it (2026-11-24)', () => {
  it('still reads, with no items to search', () => {
    const old = { places: [], stock: [], slips: [], taken: [] };
    expect(jobStockSchema.parse(old)).toEqual({ ...old, catalog: [] });
  });

  it('still reads a slip that does not name its truck, from a server older than that', () => {
    const slipWithoutTruck = { id: 'slip-1', number: 'WD-0031', kind: 'WITHDRAWAL', at: '2026-11-19T15:00:00.000Z', place: 'Truck 1', reversed: false, lines: [filter(2)] };
    expect(jobStockSchema.parse({ places: [], stock: [], slips: [slipWithoutTruck], taken: [], catalog: [] }).slips).toEqual([{ ...slipWithoutTruck, placeId: null }]);
  });
});

/**
 * 2026-11-24, found in review: what was taken was capped across every truck,
 * so five taken from the shared truck could be "put back" into the
 * technician's own -- a move between trucks from the phone.
 */
describe('what can go back into a truck', () => {
  const recorded = (placeId: string | null, kind: 'WITHDRAWAL' | 'RETURN', lines: JobStockItem[]) => ({ id: `slip-${placeId}-${kind}`, number: 'WD-0001', kind, at: '2026-11-19T15:00:00.000Z', place: 'Truck', placeId, reversed: false, lines });

  it('is only what was taken from that truck for the job', () => {
    const slips = [recorded('truck-2', 'WITHDRAWAL', [battery(2)]), recorded('truck-1', 'WITHDRAWAL', [filter(3)])];
    expect(takenFromTruck(slips, [], 'truck-1')).toEqual([filter(3)]);
    expect(takenFromTruck(slips, [], 'truck-2')).toEqual([battery(2)]);
  });

  it('counts what this phone is holding for that truck only', () => {
    const slips = [recorded('truck-1', 'WITHDRAWAL', [filter(3)])];
    const held = [slip({ kind: 'RETURN', named: [filter(1)] }), slip({ placeId: 'truck-2', named: [battery(1)], clientRequestId: 'slip-key-0002' })];
    expect(takenFromTruck(slips, held, 'truck-1')).toEqual([filter(2)]);
    expect(takenFromTruck(slips, held, 'truck-2')).toEqual([battery(1)]);
  });
});
