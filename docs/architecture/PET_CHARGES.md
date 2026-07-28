# Pet violations & configurable charges

Occupied inspections can produce a **$25 charge per unique unauthorized pet**
(spec §13). The amount is **configurable, never hard-coded**, the charge applies
**only when a business rule is configured and active**, and **only a human**
confirms uniqueness/authorization and finalizes any charge. AI may draft a
recommendation but never finalizes financial responsibility (spec §14).

## Roles

- **Technician** records **evidence only**: species, a temporary label
  ("Brown dog"), distinguishing characteristics, notes, and photo/video evidence
  ids. Endpoint `POST /technician/inspections/:id/pet-observations` (occupied
  inspections only). No uniqueness, authorization, or charge determination.
- **Administrator / reviewer** (`charges:review`) confirms unique animals,
  authorization, and every charge decision. `charges:configure` sets the rule.

## Deduplication → unique animals

`POST /admin/inspections/:id/pets/generate` groups ungrouped observations into
`PetCandidate`s by species + normalized label. A dog seen in three rooms groups
to **one** candidate (observationCount = 3); a different animal is a separate
candidate. Grouping is only a draft — a reviewer confirms it.

`POST /admin/pet-candidates/:id/review` sets:

- `reviewStatus`: `UNIQUE_PET` / `DUPLICATE` / `INSUFFICIENT_EVIDENCE`;
- `authorizationStatus`: `AUTHORIZED` / `UNAUTHORIZED` / `UNKNOWN`.

The system never assumes an animal is unauthorized without this confirmation.

## Configurable rule

`ChargeRule` (`charges:configure` to edit) stores the amount, not code:

```
code            = UNAUTHORIZED_PET
amount          = 25.00        (Decimal — configurable)
currency        = USD
calculationType = PER_UNIQUE_ENTITY
isActive        = true
```

## Charge generation & human finalization

`POST /admin/inspections/:id/charges/generate` drafts a charge for every
candidate that is **`UNIQUE_PET` and `UNAUTHORIZED`** and not already charged, at
the active rule amount (`confirmed unique unauthorized pets × amount`). Drafts
land as **`PENDING_REVIEW`** with `source = SYSTEM` — never `APPROVED`. If no
active `UNAUTHORIZED_PET` rule exists, generation fails
(`409 CHARGE_RULE_NOT_CONFIGURED`).

Administrators can also add a charge manually (`source = ADMINISTRATOR`, e.g. a
damage charge tied to a finding). Every charge is finalized only through
`POST /admin/charges/:id/review` `{ decision: APPROVE|REJECT|ADJUST|WAIVE, approvedAmount?, reason? }`
(`charges:review`) — the sole path out of DRAFT/PENDING_REVIEW:

- `APPROVE` → `APPROVED`, approvedAmount = proposed (or provided);
- `ADJUST` → `ADJUSTED`, approvedAmount required;
- `WAIVE` → `WAIVED`, approvedAmount = 0;
- `REJECT` → `REJECTED`, approvedAmount = null.

Every decision writes an `AuditLog` row (`CHARGE_APPROVED`, `CHARGE_REJECTED`,
`CHARGE_ADJUSTED`, `CHARGE_WAIVED`, plus `CHARGE_CREATED`, `CHARGES_GENERATED`,
`PET_CANDIDATE_REVIEWED`, `CHARGE_RULE_UPDATED`). There is no code path where AI
or the generator sets a charge `APPROVED`.

## Charge comparison report (spec §14)

`GET /admin/inspections/:id/charge-report` (`charges:review`) returns export-ready
structured data combining: property/lease summary, move-in vs move-out comparison,
new/worsened findings, existing-condition exclusions, pet review, proposed /
approved / rejected charges, the active rule, and totals (proposed vs approved).
Each charge carries its `source` so the report distinguishes an AI suggestion, a
technician observation, and an administrator decision. A printable web view lives
at `/inspections/:id/charge-report` (print-optimized CSS). Internal AI reasoning
is never exposed; only evidence and source records are shown.

## Data model

`ChargeRule`, `PetObservation` (evidence, with photo/media id arrays),
`PetCandidate` (dedup + review), `Charge` (Decimal money; proposed vs approved;
status + source). External links are plain FK columns; pet observations and
charges relate to a `PetCandidate` via Prisma relations. A durable
`comparison_reports` snapshot table (spec §17) remains a deferred enhancement —
the report is computed on demand.
