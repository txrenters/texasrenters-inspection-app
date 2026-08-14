'use client';

import type { EntitySyncMetadata, SyncState } from '@texasrenters/shared';
import { entityRevision, isOlderRevision, isRevisionedEntity } from '@texasrenters/shared';
import type { QueryClient, QueryKey } from '@tanstack/react-query';

const VERIFY_GUARD_MS = 30_000;
const DELETE_TOMBSTONE_MS = 5 * 60_000;

interface EntityGuard {
  operationId: string;
  sequence: number;
  state: SyncState;
  shadow?: Record<string, unknown>;
  authoritativeRevision: number | null;
  tombstone: boolean;
  expiresAt: number;
}

export type SynchronizedEntity<T> = T & {
  __sync?: EntitySyncMetadata;
};

const guards = new Map<string, EntityGuard>();
let operationSequence = 0;

export function createOperationId(label = 'mutation') {
  const random =
    typeof globalThis.crypto?.randomUUID === 'function'
      ? globalThis.crypto.randomUUID()
      : `${Date.now()}-${Math.random().toString(36).slice(2)}`;
  return `${label}:${random}`;
}

export function beginEntityOperation(
  entityId: string,
  state: Exclude<SyncState, 'SYNCED' | 'VERIFYING' | 'FAILED'>,
  shadow?: object,
) {
  const operationId = createOperationId(state.toLowerCase());
  guards.set(entityId, {
    operationId,
    sequence: ++operationSequence,
    state,
    shadow: shadow as Record<string, unknown> | undefined,
    authoritativeRevision: null,
    tombstone: state === 'DELETING',
    expiresAt: Number.POSITIVE_INFINITY,
  });
  consistencyDiagnostic('started', operationId, state);
  return operationId;
}

export function updateEntityIntent(
  entityId: string,
  operationId: string,
  shadow: Record<string, unknown>,
) {
  const guard = guards.get(entityId);
  if (!guard || guard.operationId !== operationId) return false;
  guard.shadow = { ...guard.shadow, ...shadow };
  return true;
}

export function completeEntityOperation(
  entityId: string,
  operationId: string,
  authoritative?: unknown,
) {
  const guard = guards.get(entityId);
  if (!guard || guard.operationId !== operationId) {
    consistencyDiagnostic('stale-result-rejected', operationId);
    return false;
  }
  guard.state = 'VERIFYING';
  guard.tombstone = false;
  guard.shadow =
    authoritative && typeof authoritative === 'object'
      ? (authoritative as Record<string, unknown>)
      : guard.shadow;
  guard.authoritativeRevision = entityRevision(authoritative);
  guard.expiresAt = Date.now() + VERIFY_GUARD_MS;
  consistencyDiagnostic('succeeded', operationId);
  return true;
}

export function completeEntityDeletion(entityId: string, operationId: string) {
  const guard = guards.get(entityId);
  if (!guard || guard.operationId !== operationId) {
    consistencyDiagnostic('stale-delete-rejected', operationId);
    return false;
  }
  guard.state = 'VERIFYING';
  guard.tombstone = true;
  guard.shadow = undefined;
  guard.expiresAt = Date.now() + DELETE_TOMBSTONE_MS;
  consistencyDiagnostic('succeeded', operationId, 'DELETING');
  return true;
}

export function failEntityOperation(entityId: string, operationId: string, message?: string) {
  const guard = guards.get(entityId);
  if (!guard || guard.operationId !== operationId) return false;
  guards.delete(entityId);
  consistencyDiagnostic('rolled-back', operationId, message ? 'FAILED' : undefined);
  return true;
}

export function isLatestEntityOperation(entityId: string, operationId: string) {
  return guards.get(entityId)?.operationId === operationId;
}

export function entitySyncMetadata(value: unknown): EntitySyncMetadata | undefined {
  if (!value || typeof value !== 'object') return undefined;
  return (value as { __sync?: EntitySyncMetadata }).__sync;
}

/**
 * Global TanStack structural-sharing guard. It preserves a pending intent,
 * rejects lower revisions, and keeps successful delete tombstones from being
 * recreated by an older cache/read response.
 */
export function reconcileServerState<T>(previous: unknown, incoming: T): T {
  return reconcileValue(previous, incoming) as T;
}

/**
 * Applies a server response over every cached copy of that entity.
 *
 * This **merges** rather than replaces. Mutation endpoints return narrow
 * projections — the finding review endpoint, for instance, returns only
 * `{ id, inspectionId, reviewStatus }` — while list queries hold the full
 * record. Replacing outright dropped every field the response omitted, so
 * approving a finding left the cached list item with three keys and the next
 * render crashed on a missing enum.
 *
 * An absent key means "unchanged", not "cleared". A field the server genuinely
 * nulls arrives as an explicit `null` and still overwrites.
 */
export function patchEntityInQueries<T extends { id: string }>(
  client: QueryClient,
  queryKey: QueryKey,
  entity: T,
) {
  client.setQueriesData({ queryKey }, (current) =>
    replaceEntity(current, entity.id, (existing) => ({ ...existing, ...entity })),
  );
}

export function mergeAuthoritativeEntity<T extends { id: string }>(
  client: QueryClient,
  queryKey: QueryKey,
  entity: T,
) {
  const operationId = beginEntityOperation(entity.id, 'UPDATING', entity);
  completeEntityOperation(entity.id, operationId, entity);
  patchEntityInQueries(client, queryKey, entity);
}

export function clearEntityOperation(entityId: string, operationId: string) {
  const guard = guards.get(entityId);
  if (!guard || guard.operationId !== operationId) return false;
  guards.delete(entityId);
  return true;
}

export function patchEntityById(
  client: QueryClient,
  queryKey: QueryKey,
  entityId: string,
  patch: Record<string, unknown>,
  metadata?: EntitySyncMetadata,
) {
  client.setQueriesData({ queryKey }, (current) =>
    replaceEntity(current, entityId, (entity) => ({
      ...entity,
      ...patch,
      ...(metadata ? { __sync: metadata } : {}),
    })),
  );
}

export function snapshotEntity<T extends { id: string }>(
  client: QueryClient,
  queryKey: QueryKey,
  entityId: string,
) {
  for (const [, value] of client.getQueriesData({ queryKey })) {
    const found = findEntity(value, entityId);
    if (found) return found as T;
  }
  return undefined;
}

export function removeEntityFromQueries(
  client: QueryClient,
  queryKey: QueryKey,
  entityId: string,
) {
  client.setQueriesData({ queryKey }, (current) => removeEntity(current, entityId));
}

export function replaceTemporaryEntity<T extends { id: string }>(
  client: QueryClient,
  queryKey: QueryKey,
  temporaryId: string,
  authoritative: T,
) {
  client.setQueriesData({ queryKey }, (current) =>
    replaceEntity(current, temporaryId, () => authoritative),
  );
}

export function insertEntityIntoList<T>(
  client: QueryClient,
  queryKey: QueryKey,
  entity: T,
  position: 'start' | 'end' = 'end',
) {
  client.setQueryData<T[]>(queryKey, (current = []) =>
    position === 'start' ? [entity, ...current] : [...current, entity],
  );
}

export async function cancelAffectedQueries(client: QueryClient, queryKeys: QueryKey[]) {
  await Promise.all(queryKeys.map((queryKey) => client.cancelQueries({ queryKey })));
}

export function verifyAffectedQueries(client: QueryClient, queryKeys: QueryKey[]) {
  return Promise.all(
    queryKeys.map((queryKey) =>
      client.invalidateQueries({ queryKey, refetchType: 'active' }).catch(() => undefined),
    ),
  );
}

function reconcileValue(previous: unknown, incoming: unknown): unknown {
  if (Array.isArray(incoming)) {
    const previousItems = Array.isArray(previous) ? previous : [];
    const previousById = new Map(
      previousItems
        .filter(isRevisionedEntity)
        .map((entity) => [entity.id, entity] as const),
    );
    const nextIds = new Set<string>();
    const reconciled = incoming
      .map((item, index) => {
        const oldItem = isRevisionedEntity(item)
          ? previousById.get(item.id)
          : previousItems[index];
        if (isRevisionedEntity(item)) nextIds.add(item.id);
        return reconcileValue(oldItem, item);
      })
      .filter((item) => item !== TOMBSTONED);
    for (const oldItem of previousItems) {
      if (!isRevisionedEntity(oldItem) || nextIds.has(oldItem.id)) continue;
      const guard = activeGuard(oldItem.id);
      if (guard && !guard.tombstone) reconciled.push(applyGuard(oldItem, guard));
    }
    return reconciled;
  }
  if (!isPlainObject(incoming)) return incoming;

  if (isRevisionedEntity(incoming)) {
    const guard = activeGuard(incoming.id);
    if (guard?.tombstone) return TOMBSTONED;
    if (guard) {
      const candidateRevision = entityRevision(incoming);
      if (
        guard.state === 'VERIFYING' &&
        guard.authoritativeRevision !== null &&
        candidateRevision !== null &&
        candidateRevision >= guard.authoritativeRevision
      ) {
        guards.delete(incoming.id);
      } else {
        consistencyDiagnostic('stale-read-rejected', guard.operationId);
        return applyGuard(incoming, guard);
      }
    }
    if (isOlderRevision(incoming, previous)) return previous;
  }

  const previousObject = isPlainObject(previous) ? previous : {};
  return Object.fromEntries(
    Object.entries(incoming).map(([key, value]) => [
      key,
      reconcileValue(previousObject[key], value),
    ]),
  );
}

function applyGuard(value: unknown, guard: EntityGuard) {
  const entity = isPlainObject(value) ? value : {};
  return {
    ...entity,
    ...guard.shadow,
    __sync: {
      state: guard.state,
      operationId: guard.operationId,
    } satisfies EntitySyncMetadata,
  };
}

function activeGuard(entityId: string) {
  const guard = guards.get(entityId);
  if (guard && guard.expiresAt <= Date.now()) {
    guards.delete(entityId);
    return undefined;
  }
  return guard;
}

function replaceEntity(
  value: unknown,
  entityId: string,
  replace: (entity: Record<string, unknown>) => unknown,
): unknown {
  if (Array.isArray(value))
    return value.map((item) => replaceEntity(item, entityId, replace));
  if (!isPlainObject(value)) return value;
  if (value.id === entityId) return replace(value);
  return Object.fromEntries(
    Object.entries(value).map(([key, child]) => [key, replaceEntity(child, entityId, replace)]),
  );
}

function removeEntity(value: unknown, entityId: string): unknown {
  if (Array.isArray(value))
    return value
      .filter((item) => !isRevisionedEntity(item) || item.id !== entityId)
      .map((item) => removeEntity(item, entityId));
  if (!isPlainObject(value)) return value;
  return Object.fromEntries(
    Object.entries(value).map(([key, child]) => [key, removeEntity(child, entityId)]),
  );
}

function findEntity(value: unknown, entityId: string): Record<string, unknown> | undefined {
  if (Array.isArray(value)) {
    for (const item of value) {
      const found = findEntity(item, entityId);
      if (found) return found;
    }
    return undefined;
  }
  if (!isPlainObject(value)) return undefined;
  if (value.id === entityId) return value;
  for (const child of Object.values(value)) {
    const found = findEntity(child, entityId);
    if (found) return found;
  }
  return undefined;
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

const TOMBSTONED = Symbol('tombstoned');

function consistencyDiagnostic(event: string, operationId: string, state?: string) {
  if (process.env.NODE_ENV === 'production') return;
  console.info('[state-consistency]', { event, operationId, state });
}
