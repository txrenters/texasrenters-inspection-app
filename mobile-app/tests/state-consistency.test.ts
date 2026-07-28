import {
  beginIntent,
  completeDeletion,
  completeIntent,
  failIntent,
  reconcileMobileState,
} from '../src/features/state-consistency';

describe('mobile state consistency', () => {
  it('keeps a pending offline note over a stale refetch', () => {
    const operation = beginIntent('room-mobile-1', 'OFFLINE_PENDING', {
      note: 'Water damage near window',
    });
    const result = reconcileMobileState(undefined, {
      id: 'room-mobile-1',
      note: 'Old note',
      updatedAt: '2026-07-28T01:00:00.000Z',
    });
    expect(result).toMatchObject({
      note: 'Water damage near window',
      __sync: { state: 'OFFLINE_PENDING', operationId: operation },
    });
    failIntent('room-mobile-1', operation);
  });

  it('rejects an out-of-order completion', () => {
    const first = beginIntent('finding-mobile-1', 'UPDATING', { observation: 'First' });
    const second = beginIntent('finding-mobile-1', 'UPDATING', { observation: 'Latest' });
    expect(
      completeIntent('finding-mobile-1', first, {
        id: 'finding-mobile-1',
        observation: 'First',
      }),
    ).toBe(false);
    expect(
      reconcileMobileState(undefined, {
        id: 'finding-mobile-1',
        observation: 'First',
      }),
    ).toMatchObject({
      observation: 'Latest',
      __sync: { operationId: second },
    });
    failIntent('finding-mobile-1', second);
  });

  it('does not resurrect an entity after delete confirmation', () => {
    const operation = beginIntent('upload-mobile-1', 'DELETING');
    completeDeletion('upload-mobile-1', operation);
    expect(
      reconcileMobileState([], [{ id: 'upload-mobile-1', status: 'PENDING' }]),
    ).toEqual([]);
  });
});
