export const syncStates = [
  'SYNCED',
  'CREATING',
  'UPDATING',
  'DELETING',
  'UPLOADING',
  'PROCESSING',
  'VERIFYING',
  'OFFLINE_PENDING',
  'RETRYING',
  'FAILED',
] as const;

export type SyncState = (typeof syncStates)[number];

/**
 * Client-only metadata. It is intentionally prefixed and must never be
 * persisted as domain state by the API.
 */
export interface EntitySyncMetadata {
  state: SyncState;
  operationId: string;
  error?: string;
}

export interface RevisionedEntity {
  id: string;
  version?: number | null;
  updatedAt?: string | null;
}

export function entityRevision(value: unknown): number | null {
  if (!value || typeof value !== 'object') return null;
  const entity = value as Partial<RevisionedEntity>;
  if (typeof entity.version === 'number' && Number.isFinite(entity.version))
    return entity.version;
  if (typeof entity.updatedAt !== 'string') return null;
  const timestamp = Date.parse(entity.updatedAt);
  return Number.isFinite(timestamp) ? timestamp : null;
}

export function isRevisionedEntity(value: unknown): value is RevisionedEntity {
  return Boolean(
    value &&
      typeof value === 'object' &&
      typeof (value as Partial<RevisionedEntity>).id === 'string',
  );
}

export function isOlderRevision(candidate: unknown, current: unknown) {
  const candidateRevision = entityRevision(candidate);
  const currentRevision = entityRevision(current);
  return (
    candidateRevision !== null &&
    currentRevision !== null &&
    candidateRevision < currentRevision
  );
}
