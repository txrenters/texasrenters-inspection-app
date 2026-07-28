# State consistency

## Global rule

The user's latest intended state remains visible until the server confirms or rejects it. An
older cache, delayed refetch, read replica, persisted device cache, realtime event, or
out-of-order response must never silently restore previous data.

The web and mobile clients attach client-only `__sync` metadata to affected entities. It is
never submitted as domain data:

`SYNCED`, `CREATING`, `UPDATING`, `DELETING`, `UPLOADING`, `PROCESSING`, `VERIFYING`,
`OFFLINE_PENDING`, `RETRYING`, or `FAILED`.

Each operation has a privacy-safe operation ID. Per-entity guards preserve the current shadow
intent, reject superseded mutation results, reject lower `version`/`updatedAt` reads, and retain
delete tombstones. Successful authoritative responses are applied before background
verification begins.

## Decisions

- Reversible text and metadata edits use optimistic state with entity-scoped rollback.
- Approval, completion, charge review, AI processing, and other consequential actions show an
  explicit pending state and wait for an authoritative response.
- Creates use a temporary client ID only when the UI needs a provisional row.
- Deletes hide immediately and retain a bounded tombstone after success.
- A form draft is separate from server cache state. A newer server revision does not reset a
  dirty form; the UI surfaces a conflict.
- Server revisions are `version` when present, otherwise `updatedAt`.

The implementations are `web-app/lib/state-consistency.ts` and
`mobile-app/src/features/state-consistency.ts`; the shared state vocabulary and revision helpers
are in `shared/src/state/sync.ts`.

