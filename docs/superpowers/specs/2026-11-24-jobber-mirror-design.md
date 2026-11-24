# Jobber mirror — design

Date: 2026-11-24
Status: draft, awaiting office review
Follow-up: work-order two-way scheduling (separate spec, project 2)

## Why

The office is removing Jobber soon. Until then, every record Jobber holds must
also live in our database, kept current, so that nothing is lost on the day the
account is closed. After that day the copy is a permanent read-only archive.

What the office said (2026-11-24):

- Mirror everything: jobs and every visit, clients and properties, quotes and
  requests, notes and attachments — "all".
- Visit **Details** and **notes** explicitly (the tenant's description on a
  work-order visit, e.g. "our toilet is clogged…").
- For now this is a mirror: a copy, not our working records.
- Do not make the laptop lag.

## Not in scope

- Turning mirrored records into this app's own clients, jobs or quotes.
- Any write to Jobber. The mirror only reads. (Two-way work-order scheduling
  is project 2.)
- Invoices and payments: already mirrored by `jobber-invoice.worker.ts` and
  `jobber-invoice-files.worker.ts`; not fetched again.
- Changing how the existing visit sync turns visits into inspections.

## What exists today

| Jobber data | In our database today |
|---|---|
| Visits, 7 days back to 60 ahead | Raw payload on `JobberVisitImport`; inspection visits become `Inspection`s |
| Invoices, payments, invoice notes/files | Mirrored |
| Properties | Only `JobberPropertyLink` (id ↔ our property) |
| Jobs, clients, quotes, requests, job/visit notes, older visits | Not stored |

## Data model

Three new tables, all scoped by `organizationId` (cascade on organization
delete, like every Jobber table).

### `JobberRecord`

One row per Jobber record of any mirrored kind.

| Column | Notes |
|---|---|
| `id` | uuid |
| `organizationId` | |
| `kind` | enum `JobberRecordKind`: `JOB`, `VISIT`, `CLIENT`, `PROPERTY`, `QUOTE`, `REQUEST`, `NOTE` |
| `jobberId` | Jobber's encoded id |
| `payload` | `Json` — the record exactly as Jobber returned it |
| `number` | job / quote / request number, when the kind has one |
| `title` | job/visit/quote title, client name, or note's first line |
| `clientJobberId`, `propertyJobberId`, `jobJobberId` | the record's parents, for joins without parsing JSON |
| `address` | one-line address, when the kind has one |
| `occursAt` | visit start, job start, quote/request created — the date the office would search by |
| `status` | Jobber's status string, as sent |
| `jobberCreatedAt`, `jobberUpdatedAt` | as sent; `jobberUpdatedAt` null for kinds that have none (visits) |
| `deletedInJobberAt` | set when the record disappears from Jobber; never erased |
| `extractFailed` | true when the payload saved but the summary columns could not be read |
| `fetchedAt`, `createdAt`, `updatedAt` | |

Constraints: `@@unique([organizationId, kind, jobberId])` — a replayed page or an
overlapping run overwrites rather than duplicates. Indexes on
`[organizationId, kind, occursAt]`, `[organizationId, kind, number]`,
`[organizationId, clientJobberId]`, `[organizationId, jobJobberId]`.

Visit **Details** are the visit's `instructions` field (the name the visit sync
already uses, `VISIT_DETAILS_FIELD`); kept in `payload`. Notes are their own
`NOTE` rows, with `jobJobberId` or the visit/client they hang off in the
parent columns.

### `JobberRecordFile`

One row per note attachment.

| Column | Notes |
|---|---|
| `id`, `organizationId` | |
| `recordId` | the `NOTE` row it belongs to |
| `jobberFileId` | unique with `organizationId` |
| `fileName`, `contentType`, `sizeBytes` | as Jobber reports them |
| `storageKey` | null until downloaded |
| `status` | `PENDING`, `STORED`, `FAILED` |
| `attempts`, `lastError`, `nextAttemptAt` | |

The Jobber download URL is short-lived and is never stored; it is re-read from
the note when the file is fetched. Bytes go to object storage through the same
storage base the invoice files use (`InvoiceFileStorageService`'s
`ObjectStorage`), under a `jobber-mirror/` prefix.

### `JobberMirrorCursor`

One row per `(organizationId, kind)`.

| Column | Notes |
|---|---|
| `phase` | `BACKFILL` or `INCREMENTAL` |
| `afterCursor` | Jobber's `endCursor` for the page to fetch next (backfill) |
| `changedSince` | high-water mark of `jobberUpdatedAt` (incremental) |
| `recordsSeen` | running count, for the status view |
| `lastRunStartedAt`, `lastRunFinishedAt`, `lastError` | |

## Sync

A new worker, `JobberMirrorWorker`, in `workers/jobber-sync/`, driven by its own
cron (`JOBBER_MIRROR_CRON`), with an overlap guard like
`JobberSyncScheduler`'s. Off unless `JOBBER_MIRROR_ENABLED=true`.

Each run walks the kinds in a fixed order — clients, properties, jobs, visits,
quotes, requests, notes — one at a time, one page at a time.

1. **Backfill.** Page through every record of the kind from the start, writing
   each page in one transaction (upsert by the unique key) and saving
   `afterCursor` in the same transaction. An interrupted run resumes from the
   saved cursor. When `hasNextPage` is false the cursor moves to
   `INCREMENTAL` with `changedSince` set to the run's start.
2. **Incremental.** For kinds Jobber can filter by `updatedAt` (to be confirmed
   per kind — see *Unverified*), fetch only records changed since
   `changedSince`. Visits have no `updatedAt` (proven by the visit sync), so
   they are re-read in a rolling window, `JOBBER_MIRROR_VISIT_WINDOW_DAYS`
   back and forward; visits outside it do not change in practice once done.
3. **Deletions.** Jobber's webhook already reports `VISIT_DESTROY`; it also
   marks the mirrored visit `deletedInJobberAt`. For other kinds, a full
   re-walk at most weekly (`JOBBER_MIRROR_RECONCILE_CRON`) marks rows not seen
   as deleted. Nothing is ever removed.
4. **Attachments.** A separate, slower loop takes up to
   `JOBBER_MIRROR_FILE_BATCH` (default 5) `PENDING` files per tick, re-reads
   each note for a fresh URL, downloads, stores, marks `STORED`. Failures back
   off; after 5 attempts the file is `FAILED` with the reason.

### Keeping the load down

- Page size is small (`first: 25`) and every query selects only what the
  payload needs; Jobber prices queries by `first` × fields.
- Before each page the worker reads the last response's
  `throttleStatus`; if `currentlyAvailable` is below half of
  `maximumAvailable` it waits `deficit / restoreRate` seconds. The inspection
  visit sync and the outbound worker are never starved: the mirror yields,
  they do not.
- A run stops after `JOBBER_MIRROR_MAX_PAGES_PER_RUN` (default 40) and resumes
  next tick, so a backfill is spread over many ticks instead of one long burst.
- The backfill runs on the server. Locally the mirror stays off.

### Billed calls

Jobber does not bill per call; the limit is its query-cost throttle, handled
above. No Mapbox, Google, AI or messaging provider is called. Object storage
for attachments is the only cost; it grows once per file, never per run.

## Errors

| What happens | What the mirror does |
|---|---|
| A kind's query fails (Jobber error, unknown field) | That kind stops; `lastError` saved on its cursor; retried next run; other kinds carry on |
| A record's shape is unexpected | Payload saved anyway, summary columns null, `extractFailed = true` |
| Throttled (`THROTTLED`) | Wait as above, then continue the same page |
| Jobber disconnected / token gone | Run stops; nothing already copied is touched |
| Attachment fails | Retried with back-off; `FAILED` after 5 attempts; never blocks its note |

## Visibility

`GET /admin/integrations/jobber/mirror` (permission
`integrations:read`, as the other Jobber status endpoints in
`jobber.controller.ts`) returns, per kind: phase,
records copied, files stored / pending / failed, last run, last error. Enough
for the office to see the copy is complete before Jobber is closed. Read-only;
no browse screens in this project.

## Security

- Organization ownership on every query and every row.
- No Jobber token, download URL or secret is stored in `JobberRecord` or logged.
- The status endpoint returns counts and error codes, not payloads.

## Testing

Unit tests with recorded Jobber responses (no live calls, no Docker):

- a backfill interrupted mid-kind resumes from the saved cursor;
- writing the same page twice leaves one row per record;
- a record missing from a reconcile is marked deleted, not erased;
- one kind failing does not stop the next;
- the worker waits when `currentlyAvailable` is low;
- a malformed record is saved with `extractFailed`;
- an attachment failing five times ends `FAILED` and the note is unaffected.

Database tests for the new tables run alone against the local portable
Postgres, not the whole suite.

## Unverified — first step of implementation

The field names for jobs, clients, properties, quotes, requests and notes, and
which of them accept an `updatedAt` filter, are not proven against this
account's pinned `JOBBER_API_VERSION`. The first implementation step is one
small query per kind, run on the server, before any worker code depends on it.
Kinds without an `updatedAt` filter fall back to the visit approach (rolling
window) or to the weekly reconcile.
