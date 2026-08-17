# Backend performance baseline

Measured on 2026-07-21 from the development workstation in the Philippines against the existing Supabase PostgreSQL project in Canada Central. These figures include wide-area network latency and are diagnostic measurements, not production SLOs.

## Reproduce

```powershell
npm run perf:database
npm run perf:database:session
$env:PERF_API_BASE_URL='http://127.0.0.1:3000'
npm run perf:endpoints
npm run perf:query-plans
```

The scripts never print credentials or SQL parameters. Endpoint instrumentation is exposed through `Server-Timing`, `X-Database-Query-Count`, and `X-Response-Bytes`. Global fallback query counting is intended only for isolated development benchmarks and is disabled in production unless explicitly enabled.

## Database connection results

Twelve samples were collected. `median` and `p95` exclude the first cold request.

| Operation            | Transaction pooler 6543 cold |    6543 median / p95 | Session pooler 5432 cold | 5432 median / p95 |
| -------------------- | ---------------------------: | -------------------: | -----------------------: | ----------------: |
| `SELECT 1`           |                   3,684.0 ms | 1,534.4 / 1,832.6 ms |               2,837.0 ms |  306.9 / 308.2 ms |
| Indexed user lookup  |                   1,534.6 ms | 1,477.9 / 1,879.2 ms |                 531.3 ms |  284.4 / 332.5 ms |
| Active property page |                   1,519.3 ms | 1,367.1 / 1,621.8 ms |                 564.6 ms |  269.7 / 368.2 ms |

The persistent NestJS process now rejects the shared transaction pooler and selects an already-configured approved session-pooler URL on port 5432. Migrations continue to use the separate direct URL.

## REST endpoint results

Seven isolated samples were collected after the changes. The backend ran locally while PostgreSQL remained in Canada Central.

| Endpoint               | Before warm median / p95 |  Before queries | After warm median / p95 |   After queries | Payload |
| ---------------------- | -----------------------: | --------------: | ----------------------: | --------------: | ------: |
| Health                 |            5.5 / 18.4 ms |               0 |           4.1 / 19.6 ms |               0 |    54 B |
| Database health        |         295.1 / 358.6 ms |               1 |        306.5 / 308.6 ms |               1 |   216 B |
| Admin dashboard        |    16.2 / 18.1 ms cached | 11 cold, 0 warm |   10.7 / 18.0 ms cached | 11 cold, 0 warm | 2,274 B |
| Inspection list        |     1,535.5 / 3,489.1 ms |               6 |        307.3 / 584.5 ms |               2 | 1,970 B |
| Technician assignments |       307.0 / 1,051.1 ms |               1 |        307.5 / 786.5 ms |               1 |     2 B |
| Inspection detail      |     2,423.2 / 4,418.6 ms |               9 |        317.5 / 755.5 ms |               2 | 5,637 B |

The dashboard's first request still performs eleven independent aggregates, but they run concurrently and its organization-scoped result is cached for 30 seconds. The relation-join strategy removed Prisma's relation-loading waterfall from the inspection list and detail paths.

## Query plans and indexes

Before the new migration:

- active properties used an index scan;
- scheduled inspections required a `Sort` below `Limit`;
- latest successful Propertyware sync required a `Sort` below `Limit`.

Migration `202607210007_add_measured_read_indexes.sql` adds only the two indexes justified by those plans. It is intentionally not auto-applied; apply it in a controlled deployment window and rerun `perf:query-plans` to verify the production-sized plan.

## Remaining latency

The roughly 270–310 ms floor for one warm database round trip is geographic. Deploying the API in the same region as the primary database is the next material improvement. Client-side loading animation cannot reduce this server time and is not counted as a backend optimization.
