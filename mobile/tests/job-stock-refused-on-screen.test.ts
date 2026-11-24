import { ApiStockRepository } from '../src/repositories/api/job-stock';
import { QueuedOfflineError, savedJobStockSlips } from '../src/repositories/api/offline-writes';
import { ApiConnectionError, ApiRefusalError } from '../src/storage/offline-record-cache';
import { readStockRefusals } from '../src/storage/stock-refusals';
import { useNetworkStore } from '../src/stores/network.store';
import type { PendingSlip } from '../src/utils/job-stock';

/**
 * A slip the server refuses while the technician is watching (2026-11-24,
 * found in review). The phone lets it go, and it used to be said only in a
 * line under the button with the amounts already cleared -- gone once they
 * left the screen. It is now written down like a refusal that comes back
 * later, so the job's list says "Not recorded" until it has been read.
 * Every item, truck and job here is invented.
 */

const mockStore = new Map<string, string>();
const mockRequestJson = jest.fn();

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

jest.mock('../src/repositories/api/repositories', () => ({
  requestJson: (...args: unknown[]) => mockRequestJson(...args),
}));

const slip: PendingSlip = {
  inspectionId: 'job-1',
  kind: 'WITHDRAWAL',
  placeId: 'truck-1',
  lines: [{ itemId: 'item-filter', quantity: 2 }],
  named: [{ itemId: 'item-filter', code: 'FLT-0003', name: 'Filter 20x25x1', unit: 'each', quantity: 2 }],
  clientRequestId: 'slip-key-0001',
  queuedAt: '2026-11-24T15:00:00.000Z',
};

beforeEach(() => {
  mockStore.clear();
  mockRequestJson.mockReset();
  useNetworkStore.setState({ isOnline: true, isResolved: true });
});

describe('a slip refused while the technician watches', () => {
  it('is written down as not recorded, with what it was and why', async () => {
    mockRequestJson.mockRejectedValue(new ApiRefusalError('Somebody has just taken some of that from the truck. Look again at what is there.', 409, 'STOCK_NOT_ENOUGH'));

    await expect(new ApiStockRepository().record(slip)).rejects.toBeInstanceOf(ApiRefusalError);

    expect(await readStockRefusals()).toEqual([
      expect.objectContaining({ clientRequestId: 'slip-key-0001', inspectionId: 'job-1', kind: 'WITHDRAWAL', named: slip.named, reason: 'Somebody has just taken some of that from the truck. Look again at what is there.' }),
    ]);
    // Let go by the phone: it is not also waiting to send.
    expect(await savedJobStockSlips('job-1')).toEqual([]);
  });

  it('is not written down when it is only kept for want of signal', async () => {
    mockRequestJson.mockRejectedValue(new ApiConnectionError('cannot connect', 'transport'));

    await expect(new ApiStockRepository().record(slip)).rejects.toBeInstanceOf(QueuedOfflineError);

    expect(await readStockRefusals()).toEqual([]);
    expect(await savedJobStockSlips('job-1')).toEqual([expect.objectContaining({ clientRequestId: 'slip-key-0001' })]);
  });
});
