# Propertyware leases

Leases answer two operational questions: **is this property currently leased**,
and **when does that lease end**.

## Ingestion

Read-only, through the shared Propertyware sync — leases are one of the four
synced entities (`portfolios`, `buildings`, `units`, `leases`). Nothing writes
back to Propertyware, and neither frontend calls it directly.

```
GET https://api.propertyware.com/pw/api/rest/v1/leases
```

The response is validated by `propertywareLeaseSchema` before anything is
persisted, then normalized by `mapLease` into `PropertywareLease`. The schema is
`.passthrough()`, so unknown Propertyware fields are tolerated but never stored —
only mapped fields reach the database, and no field is invented.

| Propertyware | Stored as |
|---|---|
| `active` | `isActive` |
| `status` | `sourceStatus` (falls back to `Active`/`Inactive`) |
| `startDate` / `endDate` | `startDate` / `endDate` |
| `moveInDate` | `moveInDate` |
| `scheduleMoveOutDate` | `scheduledMoveOutDate` |
| `moveOutDate` / `noticeGivenDate` | same |
| `reasonForLeaving` | same |
| `contacts[]` | `tenantDisplayNames` (names only) |
| `portfolioID` / `buildingID` / `unitID` | resolved to local FKs |

Deliberately not stored: `baseRent`, `arBalance`, `leaseBalance`, `addendums`,
`customFields`, and contact emails/phone numbers. Financial and contact detail
is not needed to schedule or report on an inspection, and tenant contact data
carries privacy weight this system has no reason to hold. Adding any of them is
a schema migration, not a mapper tweak.

## Published-report fallback

This Propertyware integration is **not permitted to read `/leases`** — the REST
call returns HTTP 403. When `PROPERTYWARE_LEASE_REPORT_URL` is configured, a 403
on leases falls back to a published saved report rendered as JSON, mirroring the
existing portfolios fallback.

```
PROPERTYWARE_LEASE_REPORT_URL=https://app.propertyware.com/pw/00a/<report>/JSON?<token>
```

The URL carries its own access token, so it is fetched **without** credentials
and is pinned to `https://app.propertyware.com/pw/…/JSON` — a misconfigured
value cannot send that token to another host. Treat it as a secret: anyone
holding the link can read the report without logging in.

### What the report can and cannot supply

Columns are positional. The report provides Status [0], Lease Name [4], Start
[5], End [6], Notice Given [7], and **Building Entity ID [9]** — but no lease ID,
no unit, and no portfolio ID.

Consequences, each handled explicitly rather than papered over:

- **Identity.** With no lease ID, each lease is keyed by a deterministic hash of
  `building + lease name + start date` — a natural key of real Propertyware
  values, so re-syncing updates rather than duplicates. Keys are prefixed `rpt-`
  so they can never collide with the numeric IDs REST issues. A lease renamed or
  re-dated upstream keys differently and appears as a new record; the old one is
  then deactivated by the usual unseen-record pass.
- **Unit.** `PropertywareLease.unitId` and `externalUnitId` are nullable
  (migration `202607250008_lease_report_fallback`). Report leases attach at
  building level; REST leases still carry a unit.
- **Portfolio.** Recovered from the building the lease resolves to, never guessed
  from the portfolio *name* column.
- **Provenance.** `sourceFeed` is `rest` or `report`, so the two are always
  distinguishable.

Tenant names are **not** inferred from the "Lease Name" column — it is a label,
not a contact list, and REST is the only source for `tenantDisplayNames`.

### If the REST permission is later granted

REST becomes the source automatically: it is tried first, and the fallback only
runs on 403. REST leases arrive with numeric IDs and full unit links, and the
`rpt-` records — no longer seen in the feed — are deactivated by the normal pass.
Granting the permission remains the better outcome: it yields every lease rather
than whatever the saved report is filtered to, plus unit links and tenant names.

> **Check the report's own filter.** A saved report scoped to, say,
> `Active - Notice Given` returns only those leases, and the sync can import no
> more than the report contains.

## Two dates that must not be conflated

| Field | Question it answers |
|---|---|
| `endDate` | When does the lease **term** end? → renewal planning |
| `scheduledMoveOutDate` | When is the tenant **scheduled to leave**? → turnover and inspection scheduling |

They can disagree: a tenant giving early notice has a move-out well before the
term end, and a month-to-month holdover can have neither. `shared/src/leases/lease-expiry.ts`
defines expiry **solely** in terms of `endDate`; scheduled move-outs are counted
separately and neither value is ever substituted for the other.

```ts
LEASE_EXPIRING_SOON_DAYS = 60
daysUntilLeaseEnd(endDate)   // whole days, UTC-midnight floored on both sides
leaseExpiryStatus(endDate)   // EXPIRED | EXPIRING_SOON | ACTIVE | UNKNOWN
leaseExpiryLabel(endDate)    // "Ends in 12 days"
```

Both dates are floored to UTC midnight before subtracting, so a lease ending
today reads as `0` days rather than a fraction, regardless of the time of day.

## What the API exposes

`PropertyLeaseSummary` (properties list and property detail):

```
activeLeaseCount, scheduledMoveOutCount, vacantUnitCount,
expiringSoonCount, nextLeaseEndDate, summary
```

`nextLeaseEndDate` is the earliest **upcoming** term end; a lease already past
its end date is not reported as upcoming. Vacancy stays derived — an active unit
with no active lease — and statuses are always passed through from Propertyware
rather than invented.

Per unit, `AdminUnit` carries `leaseStatus`, `leaseEndDate`, and
`scheduledMoveOutDate`. `AdminLease` carries `startDate` and `endDate` for the
lease list at `GET /admin/units/:unitId/leases`.

## UI

The properties list shows the lease summary plus the next upcoming end date. The
property detail page shows the term end per unit and per lease, colour-coded by
`leaseExpiryStatus` — with the date and a plain-language label always rendered,
so the cell never depends on colour alone.
