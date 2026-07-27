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
