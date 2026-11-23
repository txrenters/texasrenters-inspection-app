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
  carries one that is still ahead, else the day it arrived, counted as the
  Texas day. The column cannot be empty. The office moves it when it
  schedules the crew.
- The same-day duplicate rule does not apply, in code or in the database
  (the booking index leaves `source = WORK_ORDER` out): two repairs at one
  property on one day are two work orders, and the key says which is which.
- A repeat of the same key updates the visit: priority, number, Jobber job
  and the work order's part of the notes. What the office added to the notes
  in the console stays; the last send's text is what gets replaced. A work
  order that was closed and is open again schedules its cancelled visit again
  (audited as `WORK_ORDER_REOPENED`, answered `updated`). A closed work order
  cancels a visit only while it is still `SCHEDULED`; one a technician has
  started is left alone and answered `unchanged`.
- Two first sends at once (a retry overtaking the original) both answer with
  the one visit; the loser updates it rather than being refused.
- `allowTechnicianAreaCapture` is on, so a property nobody has surveyed is not
  a reason to refuse the visit. No standard layout is seeded for a repair.
- `jobberJobId` is the work order's existing Jobber job, created by the
  maintenance app when the crew was assigned. Whoever books the technician
  should book the visit on that job rather than create a second one.
- `internalNotes` carries what the technician needs: number, category, urgency,
  occupancy, tenant contact, vendors, the description, and links back to the
  work order and the Jobber job.
- The audit row names the API client as the actor.
- After the answer is sent, the work order is matched to a technician by skill
  (`WorkOrderTriageService`): the AI reads the category, description, notes and
  messages summary and names job types from the office's Technicians' Scope of
  Work sheet, minor or major; `rankWorkOrderTechnicians` picks the person (N
  never; a plain Y before a limited Y before "needs improvement"; limited never
  on a major job). One AI reading per work order text, under
  `WORK_ORDER_TRIAGE_DAILY_CEILING` (300).
- **Trial by default.** Unless `WORK_ORDER_AUTO_ASSIGN=assign`, the pick is only
  recorded ("Would assign ...", shown on the work order dialog): nobody is
  assigned, notified or pushed to Jobber. With `assign`, the visit is assigned
  as the office would, and moved by hand if wrong.

## Not done here, on purpose

- No Jobber write from the hand-off itself, and no assignment unless
  `WORK_ORDER_AUTO_ASSIGN=assign` (above). Scheduling the day is the office's.
- No visit for an outside customer (Crystal Creek Air at a non-Propertyware
  home); refused with `WORK_ORDER_OUTSIDE_PROPERTY` until there is a record to
  hang it on.
- No console screen for `WorkOrderImport` yet. The table is queryable (under
  the same tenant isolation policy as every other table) and the audit log
  carries `WORK_ORDER_RECEIVED` / `WORK_ORDER_UPDATED` / `WORK_ORDER_REOPENED`
  / `WORK_ORDER_CANCELLED`, each with the estimate and the approval rule,
  recorded approver and AI confidence the envelope carried.
- No approval of anything. When the sender's rule was the AI's reading of the
  owner's messages, the visit notes say so and that nobody has confirmed it;
  the office confirms work over the threshold. No invoice is drafted for a
  work order's visit by the console's automatic drafts: the maintenance app
  bills it on the Jobber job it already has.
