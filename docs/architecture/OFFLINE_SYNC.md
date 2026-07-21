# Offline Synchronization

## Current demo behavior

Zustand persists lightweight demo metadata through SecureStore on native devices. Persisted data includes selected user, room changes, notes, local media metadata, queue items, upload failures, simulation settings, and finding decisions. Video bytes are represented by local mock URIs and are not stored in SecureStore.

When offline simulation is enabled:

- Cached mock properties, inspections, rooms, and findings remain available.
- Room recording and review remain available.
- Saved media is added to the local queue.
- Transfer progress does not advance.
- Failed and pending items remain visible and retryable after online simulation returns.

Reset Demo Data clears persisted demo state only after destructive confirmation.

## Production direction

Production structured records will use SQLite tables for cached inspections, property areas, local media, upload queue, and sync operations. Repositories—not screens—own persistence.

The production algorithm remains: transactionally persist capture metadata and local URI; enqueue an idempotent operation; request a short-lived room-bound upload session when online; checkpoint resumable progress; register media against the same inspection area; wait for backend confirmation; and only then mark local media cleanup-eligible. Never delete a local video solely because bytes were transferred.

Server authorization and approved-area state win conflicts, while device media remains recoverable. Native background upload is intentionally deferred.
