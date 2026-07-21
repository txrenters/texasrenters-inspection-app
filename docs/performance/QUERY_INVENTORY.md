# Query inventory

Counts below are bounded per request and were inspected from service code plus isolated runtime instrumentation. There are no queries inside per-record application loops on these read paths.

| Read path                | Database work                                             | Bound / cache                             | Finding                                                         |
| ------------------------ | --------------------------------------------------------- | ----------------------------------------- | --------------------------------------------------------------- |
| Admin dashboard          | 8 counts, 2 grouped aggregates, latest sync               | Organization cache, 30-second default TTL | 11 cold queries, 0 warm; concurrent and deduplicated            |
| Admin inspections        | page query plus count                                     | `pageSize` max 100                        | Relation loading reduced from 6 to 2 queries                    |
| Admin inspection detail  | joined inspection graph plus audit list                   | audit `take: 100`                         | Reduced from 9 to 2 queries; independent reads run concurrently |
| Portfolios               | page query plus count                                     | `pageSize` max 100                        | Compact select, active records only                             |
| Properties               | joined page query plus count                              | `pageSize` max 100                        | Compact select and aggregate counts                             |
| Units                    | page query plus count                                     | `pageSize` max 100                        | Server pagination; compact select                               |
| Leases                   | page query plus count                                     | `pageSize` max 100                        | Server pagination; compact select                               |
| Assignments              | assignment and/or unassigned inspection reads plus counts | `pageSize` max 100                        | Historical and unassigned branches are independently bounded    |
| Technicians              | profile page/count plus grouped assignment metrics        | `pageSize` max 100                        | Constant number of grouped queries, not per-technician N+1      |
| Technician dashboard     | assignment list and upload count                          | independent queries in parallel           | Does not expose other technicians' data                         |
| Technician collections   | one joined read per requested collection                  | assignment-scoped, hard bound 100         | Relation joins avoid waterfalls; realtime remains primary       |
| Propertyware sync runs   | one compact read                                          | latest 50                                 | Polls only while a run is active                                |
| Audit events             | one compact read attached to inspection detail            | latest 100                                | Runs concurrently with inspection graph                         |
| Propertyware sync writes | batched upserts                                           | configurable batch 50, concurrency 4      | Prevents unbounded database write concurrency                   |

All cache keys include `organizationId`. Inspection, assignment, technician-status, and successful Propertyware-sync mutations invalidate the relevant dashboard entry. Authentication is still resolved by the API guard from trusted server-side state; no role or membership decision is cached in a way that weakens authorization.
