# Offline mutation queue

Recordings and snapshots are saved locally before transfer. A queued recording has a stable
media ID, `operationId`, and `OFFLINE_PENDING` state. The same media ID is sent as the backend
idempotency key on every retry.

Queue state is persisted by Zustand device storage. The foreground runner operates independently
of the current screen. It advances one item at a time, uses exponential retry delay, keeps a
failed file visible, and resumes when the app returns to the foreground or connectivity allows.
The queue cache is updated from local durable state before room/dashboard verification occurs.

State mapping:

- queued or paused: `OFFLINE_PENDING`
- transferring: `UPLOADING`
- retry scheduled: `OFFLINE_PENDING` with an error and next attempt
- terminal local failure: `FAILED`
- server accepted: local item is removed; the server-backed record becomes authoritative

A stale API response or persisted query cache cannot replace a newer guarded local intent.
Sensitive inspection content, media, tokens, and credentials are never written to diagnostics.

