# Read-after-write consistency

The mutation response is the first authoritative read. Clients apply it before any refetch.
Verification reads run afterward and pass through revision/operation guards.

PostgreSQL writes and dependent reads occur in the same Prisma transaction where conflict
checks matter. The service returns only after commit. Redis is a backend response cache, not the
source of truth; invalidation occurs after a successful transaction and fails open. This
repository does not route post-write reads to a replica.

If a verification read is older than the mutation response, it is ignored and the latest
intent remains visible. If the backend returns a version conflict, the client keeps the user's
draft, reports the conflict, and offers reload/retry rather than silently overwriting either
side.

Delete receipts prevent ambiguity, and successful delete tombstones prevent stale list reads
from resurrecting rows. Idempotency keys are stable for assignments and media uploads; mobile
uses the durable local media ID across retries.

