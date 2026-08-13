import { QueryClient } from '@tanstack/react-query';
import { describe, expect, it, vi } from 'vitest';

import {
  beginEntityOperation,
  completeEntityDeletion,
  completeEntityOperation,
  failEntityOperation,
  mergeAuthoritativeEntity,
  reconcileServerState,
} from './state-consistency';

describe('applying a mutation response to cached lists', () => {
  it('keeps fields the response omitted', () => {
    const client = new QueryClient();
    const key = ['admin', 'inspection', 'i1', 'findings'];
    client.setQueryData(key, {
      items: [
        {
          id: 'finding-1',
          title: 'Countertop burn mark',
          comparisonResult: 'POSSIBLE_NEW_DAMAGE',
          confidence: 0.82,
          reviewStatus: 'PENDING_REVIEW',
        },
      ],
    });

    // The review endpoint returns only these three fields. Replacing rather
    // than merging left the cached item with three keys, and the next render
    // crashed reading comparisonResult.
    mergeAuthoritativeEntity(client, ['admin'], {
      id: 'finding-1',
      inspectionId: 'i1',
      reviewStatus: 'APPROVED',
    });

    expect(client.getQueryData(key)).toMatchObject({
      items: [
        {
          id: 'finding-1',
          title: 'Countertop burn mark',
          comparisonResult: 'POSSIBLE_NEW_DAMAGE',
          confidence: 0.82,
          // The field the server did send still wins.
          reviewStatus: 'APPROVED',
          inspectionId: 'i1',
        },
      ],
    });
  });

  it('still applies a field the server explicitly cleared', () => {
    const client = new QueryClient();
    const key = ['admin', 'areas'];
    client.setQueryData(key, [{ id: 'area-1', name: 'Den', skipReason: 'Blocked' }]);

    // An explicit null means cleared, unlike an absent key.
    mergeAuthoritativeEntity(client, ['admin'], { id: 'area-1', skipReason: null });

    expect(client.getQueryData(key)).toEqual([
      { id: 'area-1', name: 'Den', skipReason: null },
    ]);
  });

  it('leaves other entities untouched', () => {
    const client = new QueryClient();
    const key = ['admin', 'areas'];
    client.setQueryData(key, [
      { id: 'area-1', name: 'Den' },
      { id: 'area-2', name: 'Kitchen' },
    ]);

    mergeAuthoritativeEntity(client, ['admin'], { id: 'area-1', name: 'Study' });

    expect(client.getQueryData(key)).toEqual([
      { id: 'area-1', name: 'Study' },
      { id: 'area-2', name: 'Kitchen' },
    ]);
  });
});

describe('state consistency guard', () => {
  it('keeps the intended update visible over a stale read', () => {
    const operationId = beginEntityOperation('area-1', 'UPDATING', {
      name: 'Dining room',
      updatedAt: '2026-07-28T02:00:00.000Z',
    });
    const result = reconcileServerState(
      { id: 'area-1', name: 'Dining room', updatedAt: '2026-07-28T02:00:00.000Z' },
      { id: 'area-1', name: 'Old name', updatedAt: '2026-07-28T01:00:00.000Z' },
    );
    expect(result).toMatchObject({
      id: 'area-1',
      name: 'Dining room',
      __sync: { state: 'UPDATING', operationId },
    });
    failEntityOperation('area-1', operationId);
  });

  it('does not recreate a successfully deleted entity', () => {
    const operationId = beginEntityOperation('area-2', 'DELETING');
    completeEntityDeletion('area-2', operationId);
    const result = reconcileServerState([], [
      { id: 'area-2', name: 'Stale patio', updatedAt: '2026-07-28T01:00:00.000Z' },
    ]);
    expect(result).toEqual([]);
  });

  it('rejects an older out-of-order mutation response', () => {
    const first = beginEntityOperation('area-3', 'UPDATING', { name: 'First' });
    const second = beginEntityOperation('area-3', 'UPDATING', { name: 'Second' });
    expect(
      completeEntityOperation('area-3', first, {
        id: 'area-3',
        name: 'First',
        updatedAt: '2026-07-28T02:00:00.000Z',
      }),
    ).toBe(false);
    const result = reconcileServerState(undefined, {
      id: 'area-3',
      name: 'First',
      updatedAt: '2026-07-28T02:00:00.000Z',
    });
    expect(result).toMatchObject({
      name: 'Second',
      __sync: { operationId: second },
    });
    failEntityOperation('area-3', second);
  });

  it('accepts an equal-or-newer verification response', () => {
    vi.useFakeTimers();
    const operationId = beginEntityOperation('area-4', 'UPDATING', { name: 'Saved' });
    completeEntityOperation('area-4', operationId, {
      id: 'area-4',
      name: 'Saved',
      updatedAt: '2026-07-28T02:00:00.000Z',
    });
    const result = reconcileServerState(undefined, {
      id: 'area-4',
      name: 'Saved',
      updatedAt: '2026-07-28T02:00:00.000Z',
    });
    expect(result).not.toHaveProperty('__sync');
    vi.useRealTimers();
  });

  it.each([500, 2_000, 5_000])(
    'keeps intent visible during a %i ms mutation and delayed stale read',
    (latencyMs) => {
      vi.useFakeTimers();
      const operationId = beginEntityOperation(`latency-${latencyMs}`, 'UPDATING', {
        name: 'Latest intent',
        updatedAt: '2026-07-28T04:00:00.000Z',
      });
      vi.advanceTimersByTime(latencyMs);
      expect(
        reconcileServerState(undefined, {
          id: `latency-${latencyMs}`,
          name: 'Stale server value',
          updatedAt: '2026-07-28T03:00:00.000Z',
        }),
      ).toMatchObject({
        name: 'Latest intent',
        __sync: { operationId },
      });
      failEntityOperation(`latency-${latencyMs}`, operationId);
      vi.useRealTimers();
    },
  );
});
