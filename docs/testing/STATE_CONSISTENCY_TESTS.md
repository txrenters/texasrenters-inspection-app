# State-consistency tests

Pure guard tests cover pending intent over stale reads, out-of-order responses, equal/newer
verification, and delete resurrection. Web tests use Vitest; mobile tests use Jest.

Backend tests cover authoritative entities, conditional version conflicts, explicit delete
receipts, transaction behavior, and idempotent media/assignment paths. Latency scenarios are
modeled by applying responses in the order produced by 500 ms, 2 s, and 5 s requests rather than
the order submitted.

For every new mutation, add cases for:

- immediate intended or explicit pending state;
- success followed by a stale read;
- rollback and visible failure;
- two fast edits completing out of order;
- delete followed by stale list refetch;
- create temporary-ID replacement;
- duplicate submission/idempotency;
- unrelated query isolation;
- offline persistence and reconnect when applicable.

Manual validation also covers route changes, modal close, app background/foreground, restart
with a queued upload, focus refetch, and connectivity restoration.

