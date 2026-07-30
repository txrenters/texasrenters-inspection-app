import type { EntitySyncMetadata, SyncState } from '@texasrenters/shared';
import { entityRevision, isOlderRevision, isRevisionedEntity } from '@texasrenters/shared';
import type { QueryClient, QueryKey } from '@tanstack/react-query';

const VERIFY_GUARD_MS = 30_000;
const DELETE_TOMBSTONE_MS = 5 * 60_000;

interface Guard {
  operationId: string;
  state: SyncState;
  shadow?: Record<string, unknown>;
  authoritativeRevision: number | null;
  tombstone: boolean;
  expiresAt: number;
}

const guards = new Map<string, Guard>();
const TOMBSTONED = Symbol('tombstoned');

export function operationId(label: string) {
  const random =
    typeof globalThis.crypto?.randomUUID === 'function'
      ? globalThis.crypto.randomUUID()
      : `${Date.now()}-${Math.random().toString(36).slice(2)}`;
  return `${label}:${random}`;
}

export function beginIntent(
  entityId: string,
  state: Exclude<SyncState, 'SYNCED' | 'VERIFYING' | 'FAILED'>,
  shadow?: object,
) {
  const id = operationId(state.toLowerCase());
  guards.set(entityId, {
    operationId: id,
    state,
    shadow: shadow as Record<string, unknown> | undefined,
    authoritativeRevision: null,
    tombstone: state === 'DELETING',
    expiresAt: Number.POSITIVE_INFINITY,
  });
  diagnostic(state === 'OFFLINE_PENDING' ? 'offline-operation-queued' : 'mutation-started', id);
  return id;
}

export function completeIntent(entityId: string, id: string, authoritative: unknown) {
  const guard = guards.get(entityId);
  if (!guard || guard.operationId !== id) {
    diagnostic('stale-response-rejected', id);
    return false;
  }
  guard.state = 'VERIFYING';
  guard.shadow =
    authoritative && typeof authoritative === 'object'
      ? (authoritative as Record<string, unknown>)
      : guard.shadow;
  guard.authoritativeRevision = entityRevision(authoritative);
  guard.tombstone = false;
  guard.expiresAt = Date.now() + VERIFY_GUARD_MS;
  diagnostic('mutation-succeeded', id);
  return true;
}

export function completeDeletion(entityId: string, id: string) {
  const guard = guards.get(entityId);
  if (!guard || guard.operationId !== id) return false;
  guard.state = 'VERIFYING';
  guard.shadow = undefined;
  guard.tombstone = true;
  guard.expiresAt = Date.now() + DELETE_TOMBSTONE_MS;
  diagnostic('mutation-succeeded', id);
  return true;
}

export function failIntent(entityId: string, id: string) {
  if (guards.get(entityId)?.operationId !== id) return false;
  guards.delete(entityId);
  diagnostic('mutation-rolled-back', id);
  return true;
}

export function reconcileMobileState<T>(previous: unknown, incoming: T): T {
  return reconcile(previous, incoming) as T;
}

export function patchEntity(
  client: QueryClient,
  queryKey: QueryKey,
  entityId: string,
  patch: Record<string, unknown>,
  sync?: EntitySyncMetadata,
) {
  client.setQueriesData({ queryKey }, (current) =>
    transform(current, entityId, (entity) => ({
      ...entity,
      ...patch,
      ...(sync ? { __sync: sync } : {}),
    })),
  );
}

export function mergeEntity<T extends { id: string }>(
  client: QueryClient,
  queryKey: QueryKey,
  entity: T,
  existingOperationId?: string,
) {
  const id = existingOperationId ?? beginIntent(entity.id, 'UPDATING', entity);
  if (!completeIntent(entity.id, id, entity)) return false;
  client.setQueriesData({ queryKey }, (current) => transform(current, entity.id, () => entity));
  return true;
}

export function removeEntity(client: QueryClient, queryKey: QueryKey, entityId: string) {
  client.setQueriesData({ queryKey }, (current) => remove(current, entityId));
}

export async function cancelQueries(client: QueryClient, keys: QueryKey[]) {
  await Promise.all(keys.map((queryKey) => client.cancelQueries({ queryKey })));
}

export function verifyQueries(client: QueryClient, keys: QueryKey[]) {
  return Promise.all(
    keys.map((queryKey) =>
      client.invalidateQueries({ queryKey, refetchType: 'active' }).catch(() => undefined),
    ),
  );
}

function reconcile(previous: unknown, incoming: unknown): unknown {
  if (Array.isArray(incoming)) {
    const oldItems = Array.isArray(previous) ? previous : [];
    const oldById = new Map(
      oldItems.filter(isRevisionedEntity).map((entity) => [entity.id, entity] as const),
    );
    const nextIds = new Set<string>();
    const next = incoming
      .map((item, index) => {
        const old = isRevisionedEntity(item) ? oldById.get(item.id) : oldItems[index];
        if (isRevisionedEntity(item)) nextIds.add(item.id);
        return reconcile(old, item);
      })
      .filter((item) => item !== TOMBSTONED);
    for (const old of oldItems) {
      if (!isRevisionedEntity(old) || nextIds.has(old.id)) continue;
      const guard = activeGuard(old.id);
      if (guard && !guard.tombstone) next.push(applyGuard(old, guard));
    }
    return next;
  }
  if (!plainObject(incoming)) return incoming;
  if (isRevisionedEntity(incoming)) {
    const guard = activeGuard(incoming.id);
    if (guard?.tombstone) return TOMBSTONED;
    if (guard) {
      const revision = entityRevision(incoming);
      if (
        guard.state === 'VERIFYING' &&
        guard.authoritativeRevision !== null &&
        revision !== null &&
        revision >= guard.authoritativeRevision
      )
        guards.delete(incoming.id);
      else return applyGuard(incoming, guard);
    }
    if (isOlderRevision(incoming, previous)) return previous;
  }
  const oldObject = plainObject(previous) ? previous : {};
  return Object.fromEntries(
    Object.entries(incoming).map(([key, value]) => [key, reconcile(oldObject[key], value)]),
  );
}

function activeGuard(entityId: string) {
  const guard = guards.get(entityId);
  if (guard && guard.expiresAt <= Date.now()) {
    guards.delete(entityId);
    return undefined;
  }
  return guard;
}

function applyGuard(value: unknown, guard: Guard) {
  return {
    ...(plainObject(value) ? value : {}),
    ...guard.shadow,
    __sync: { state: guard.state, operationId: guard.operationId } satisfies EntitySyncMetadata,
  };
}

function transform(
  value: unknown,
  entityId: string,
  mapper: (entity: Record<string, unknown>) => unknown,
): unknown {
  if (Array.isArray(value)) return value.map((item) => transform(item, entityId, mapper));
  if (!plainObject(value)) return value;
  if (value.id === entityId) return mapper(value);
  return Object.fromEntries(
    Object.entries(value).map(([key, child]) => [key, transform(child, entityId, mapper)]),
  );
}

function remove(value: unknown, entityId: string): unknown {
  if (Array.isArray(value))
    return value
      .filter((item) => !isRevisionedEntity(item) || item.id !== entityId)
      .map((item) => remove(item, entityId));
  if (!plainObject(value)) return value;
  return Object.fromEntries(
    Object.entries(value).map(([key, child]) => [key, remove(child, entityId)]),
  );
}

function plainObject(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

function diagnostic(event: string, id: string) {
  if (process.env.NODE_ENV === 'production') return;
  console.info('[state-consistency]', { event, operationId: id });
}
