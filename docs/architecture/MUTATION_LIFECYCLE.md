# Mutation lifecycle

1. Generate an operation ID and cancel only affected active reads.
2. Snapshot the affected entity for rollback.
3. Register the latest operation for that entity.
4. Apply a safe optimistic patch or explicit pending metadata.
5. Submit the REST mutation. Double-submit controls remain disabled while pending.
6. Reject a response whose operation ID is no longer current.
7. On success, write the authoritative response into every matching cache before invalidation.
8. Mark the entity `VERIFYING` and refetch only affected keys in the background.
9. Accept verification only when its `version`/`updatedAt` is equal or newer.
10. On failure, remove the guard, restore the entity snapshot, and show scoped feedback.

Creates replace their temporary ID atomically. Deletes keep a five-minute tombstone so a delayed
list read cannot recreate the row. Verification guards normally expire after 30 seconds.

Backend mutations return the updated entity or an explicit delete receipt (`id`, `deleted`,
`deletedAt`). Consistency-sensitive edits can send `expectedUpdatedAt`; a mismatch returns
`409 AREA_VERSION_CONFLICT` and does not overwrite the newer row.

