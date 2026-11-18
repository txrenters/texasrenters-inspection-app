# Work orders from the maintenance app

The maintenance app (TX Maintenance, the Laravel work-order system at
maintenance.texasrenters.com) owns every work order. When one of the in-house
crews — Texas Home Maintenance Pros, Crystal Creek Air, Crystal Creek Pest — is
put on a work order, it hands the work order to this app in the same second, so
the crew's visit is scheduled here alongside every other visit. It hands the
same work order over again whenever it changes.

This app never calls the maintenance app. The one route below is the whole
integration on this side.

## The route

`POST /api/v1/gateway/work-orders`, on the third-party gateway, behind
`work-orders:manage` — a grant of its own that reaches nothing else. The
maintenance app's API client has request signing on, as every writing client
must (see [THIRD_PARTY_API_GATEWAY.md](../api/THIRD_PARTY_API_GATEWAY.md)).

Filed inside the request: the sender gets a definitive answer.

| Status | Body | What the sender does |
| --- | --- | --- |
| 201 | `{ "id": "<Inspection id or null>", "importId": "<WorkOrderImport id>", "outcome": "created" \| "updated" \| "cancelled" \| "unchanged" \| "ignored_closed" }` | Marks the work order sent. |
| 422 `WORK_ORDER_INVALID` | `details` names the fields | Fixes its payload; a contract change on both sides. |
| 422 `WORK_ORDER_PROPERTY_UNKNOWN` | | Shows staff the message: the Propertyware building is not synced here (or is inactive). |
| 422 `WORK_ORDER_OUTSIDE_PROPERTY` | | A Crystal Creek Air job at a home that is not a Propertyware property. Nothing here can schedule it yet. |
| 422 / 409 from the inspection rules | `UNIT_REQUIRED`, `INVALID_ACTIVE_UNIT`, … | Shows staff the message; the work order is sent again once it changes. |
| 500 `WORK_ORDER_NOT_FILED` | | Retries with backoff. |

Every 4xx is final on the sender's side until the work order changes; a 5xx
or a timeout is retried (15 s, 1 min, 5 min, 30 min, 1 h, then a sweep every
five minutes).

## The envelope

Every field is present on every send; unknown is `null`, never missing. Keys
this side has not met are dropped, so the sender may add a field before this
side reads it. Renaming or removing one is a contract change on both sides.

```json
{
  "idempotency_key": "tx-maintenance:work-order:2864",
  "source_system": "tx-maintenance",
  "work_order": {
    "id": 2864,
    "number": 43761,
    "propertyware_id": "4377411585",
    "source": null,
    "is_crystal_creek": false,
    "status": "Open",
    "service_status": "Assigned - Waiting on Scheduling",
    "local_status": "Updated",
    "priority": "High",
    "is_emergency": true,
    "category": "HVAC",
    "type": "Repair",
    "description": "AC not cooling since Monday",
    "specific_location": "Upstairs unit",
    "authorized_to_enter": "Yes",
    "zone": "2",
    "created_date": "2026-11-11T14:02:00+00:00",
    "approved_date": "2026-11-11T15:30:00+00:00",
    "date_to_enter": null,
    "scheduled_end_date": null,
    "completed_date": null,
    "jobber": { "job_gid": "Z2lkOi8vSm9iYmVyL0pvYi8x", "web_uri": "https://secure.getjobber.com/jobs/1" },
    "url": "https://maintenance.texasrenters.com/work_orders/2864/details"
  },
  "property": {
    "propertyware_building_id": "465764359",
    "propertyware_unit_id": null,
    "propertyware_lease_id": "1189932033",
    "portfolio_id": "1102",
    "name": "123 Demo St",
    "address": "123 Demo St",
    "address_cont": null,
    "city": "Houston",
    "state": "TX",
    "postal_code": "77001",
    "latitude": 29.76,
    "longitude": -95.36,
    "location": "DEMO | 123DEMOST"
  },
  "outside_customer": null,
  "occupied": true,
  "tenants": [{ "name": "Pat Tenant", "phone": "+15125550100", "email": "pat@example.com" }],
  "vendors": [
    { "propertyware_id": "246120584", "name": "Texas Home Maintenance Pros", "in_house": true },
    { "propertyware_id": "111", "name": "Southwinds Electric LLC", "in_house": false }
  ]
}
```

| Field | Meaning |
| --- | --- |
| `idempotency_key` | Stable per work order for life. The same key again is an update, never a second visit. Stored on the visit as `Inspection.workOrderKey`, unique per organization. |
| `work_order.status` | Propertyware's own status: `Open`, `Closed`, `Canceled By Tenant`. A closed status cancels a visit nobody has started, and leaves a started one alone. |
| `work_order.is_emergency` | `true`, `false`, or `null` when staff have not judged it yet. An emergency, or a `priority` of High, books the visit as `HIGH`. |
| `property.propertyware_building_id` | The building, by the Propertyware id the Propertyware sync already holds. Unit and lease likewise, when the work order has them. |
| `outside_customer` | A Crystal Creek Air job at a home that is not a Texas Renters property. Present only when `property` is null; refused today (see above). |
| `occupied` | Someone lives there. `false` for turnovers, re-keys and homes with no lease on file. |
| `tenants[].phone` | E.164. Context for the visit, kept in its notes the way a Jobber visit's Details carry a tenant's number — never on a shared report. |
| `vendors[].in_house` | Which vendor made it qualify. An outside vendor can be on the same job. |

Three optional fields arrived with the sender's approval filter (2026-11-19).
`work_order.cost_estimate` is the estimate the filter judged. `notes` is the
Notes tab, oldest first, private ones flagged. `approval` says which of the
sender's rules let the work order through -- `emergency`, `under_threshold`,
`owner_approved_recorded`, `owner_approved_in_messages`, `manual` -- with the
recorded approver, or the AI's reading: a confidence, a summary, and one entry
per problem on the work order (`approved`, `declined`, `not_mentioned`) with
the owner's quoted words. All three go into the visit's internal notes so the
technician reads what the owner agreed to and what to leave alone. An envelope
without them files as before.

## What it becomes

A staged `WorkOrderImport` row first, always — the envelope whole, with
`status`, `failureCode` and `failureMessage`, so a refusal has somewhere to be
recorded and a decision can be re-run from the payload. One row per work
order; a repeated hand-off updates it and bumps `receivedCount`.

Then an `Inspection` with `source = WORK_ORDER`:

- `inspectionType` is `PEST_CONTROL` when the category says pest or the
  in-house vendor is Crystal Creek Pest, else `MAINTENANCE`. Neither walks
  rooms, scores a checklist or compares to a move-in; the technician's photos
  are the evidence.
- `scheduledAt` is the day the tenant allowed entry when the work order
  carries one that is still ahead, else the day it arrived. The column cannot
  be empty. The office moves it when it schedules the crew.
- The same-day duplicate rule does not apply: two repairs at one property on
  one day are two work orders, and the key says which is which.
- `allowTechnicianAreaCapture` is on, so a property nobody has surveyed is not
  a reason to refuse the visit. No standard layout is seeded for a repair.
- `jobberJobId` is the work order's existing Jobber job, created by the
  maintenance app when the crew was assigned. Whoever books the technician
  should book the visit on that job rather than create a second one.
- `internalNotes` carries what the technician needs: number, category, urgency,
  occupancy, tenant contact, vendors, the description, and links back to the
  work order and the Jobber job.
- Nobody is assigned. The office does that, as for any visit. The audit row
  names the API client as the actor.

## Not done here, on purpose

- No technician assignment and no Jobber write. Scheduling is the office's.
- No visit for an outside customer (Crystal Creek Air at a non-Propertyware
  home); refused with `WORK_ORDER_OUTSIDE_PROPERTY` until there is a record to
  hang it on.
- No console screen for `WorkOrderImport` yet. The table is queryable and the
  audit log carries `WORK_ORDER_RECEIVED` / `WORK_ORDER_UPDATED` /
  `WORK_ORDER_CANCELLED`.
