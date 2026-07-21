# REST response design

## Summary and detail contracts

List endpoints return screen-specific summary DTOs. A summary contains only identifiers needed for navigation, values rendered in the row/card, status, and small counts or current-relation summaries. It must not contain full child collections, transcripts, finding evidence, audit payloads, provider records, hashes, storage keys, or synchronization internals.

Detail endpoints return a controlled core detail DTO. Large or independently viewed collections use a separate bounded endpoint. A screen-context endpoint is appropriate when one screen always needs the same closely related data and separate calls would create a waterfall.

Examples:

- Admin inspection list: inspection header plus property/unit/current-technician summaries.
- Admin inspection detail: header, compact snapshots, current assignment, and counts. Assignment history and audit events are separate pages.
- Mobile inspection context: assigned inspection, property presentation fields, room navigation summaries, and a pending-review count.
- Propertyware sync run list: status and aggregate metrics only; never an upstream response body.
- Propertyware sync errors: sanitized error summaries only; no external IDs, fingerprints, or raw payloads.

## Field and relation rules

- Every application-facing Prisma read uses an explicit `select`.
- Nested selects name only fields consumed by the response mapper.
- Counts use `_count`, `count`, `aggregate`, or `groupBy`; rows are not loaded merely to count them.
- List relations are bounded with `take` and deterministic ordering.
- “Latest” relations use `orderBy` plus `take: 1`.
- One screen-oriented response must not become a general relationship graph.
- Internal storage keys, credentials, source hashes, raw AI/provider output, and sensitive tenant/owner data are excluded unless a separately authorized operation strictly needs them.
- Create responses return the minimum navigation identifier when the client immediately opens the canonical detail endpoint.

## Targets

- Normal list page: under 100 KB where realistic.
- Normal detail/context response: under 250 KB unless bounded media metadata genuinely requires more.
- No unbounded collection.
- One primary context request for an important detail screen where justified.
- Query counts remain constant as page item count grows; no per-row query loops.

Clients validate important response contracts with the existing TypeScript/Zod boundary. Backend query tests assert authorization scope, required shape, and absence of broad relation loading without coupling every test to a brittle exact SQL count.
