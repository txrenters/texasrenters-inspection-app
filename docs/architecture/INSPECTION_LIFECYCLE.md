# Inspection status lifecycle

Submitting an inspection is **not** completing it. Completing all required areas
does not, on its own, finalize the inspection — only an authorized administrator
does (spec §11).

## Statuses

`InspectionStatus` (Prisma enum + `@texasrenters/shared`):

```
SCHEDULED → IN_PROGRESS → TECHNICIAN_SUBMITTED → (PROCESSING) → REVIEW_REQUIRED
                                                                     │
                              ┌──────────────────┬──────────────────┼──────────────────┐
                              ▼                  ▼                  ▼                  ▼
                          COMPLETED          UNDER_REVIEW           TBD          FOLLOW_UP_REQUIRED
                          (finalize)      (request evidence)   (deferred)      (planned follow-up)
```

- `CANCELLED` is reachable from any non-finalized state via the generic update.
- `PROCESSING` is a legacy alias for "submitted, media still processing"; the AI
  pipeline advances `TECHNICIAN_SUBMITTED` **or** `PROCESSING` to
  `REVIEW_REQUIRED` once every recording has finished
  (`MediaProcessingService.advanceInspection`).

## Transitions

| Actor | Action | From → To | Endpoint |
|---|---|---|---|
| Technician | Submit | `IN_PROGRESS → TECHNICIAN_SUBMITTED` (stamps `submittedAt`) | `POST /technician/inspections/:id/complete` |
| Pipeline | Processing done | `TECHNICIAN_SUBMITTED/PROCESSING → REVIEW_REQUIRED` | internal |
| Admin | Finalize | `* → COMPLETED` (stamps `finalizedAt`/`finalizedById`/`completedAt`) | `POST /admin/inspections/:id/finalize` |
| Admin | Mark TBD | `* → TBD` (`tbdReason`) | `POST /admin/inspections/:id/mark-tbd` |
| Admin | Require follow-up | `* → FOLLOW_UP_REQUIRED` (`followUpDueAt`, `followUpTasks`) | `POST /admin/inspections/:id/require-follow-up` |
| Admin | Request more evidence | `* → UNDER_REVIEW` | `POST /admin/inspections/:id/under-review` |
| Admin | Cancel | `* → CANCELLED` | `PATCH /admin/inspections/:id` |

`*` = any *reviewable* state (`TECHNICIAN_SUBMITTED`, `PROCESSING`,
`REVIEW_REQUIRED`, `UNDER_REVIEW`, `TBD`, `FOLLOW_UP_REQUIRED`). `COMPLETED` and
`CANCELLED` are frozen.

### Rules

- **Technician submission never sets `COMPLETED`.** The generic
  `PATCH /admin/inspections/:id` accepts only `CANCELLED` — finalization is a
  separate, permission-gated action.
- **Finalization is human-only** and gated by the `inspections:finalize`
  permission (distinct from `inspections:manage`).
- **Unresolved required items block finalization**: findings still in
  `PENDING_REVIEW`, or media still processing. An administrator may override with
  a documented reason, which is written to the audit trail
  (`INSPECTION_FINALIZED { override, overrideReason }`).
- **Follow-up** preserves the original inspection and its media/findings. A
  follow-up inspection links back through `parentInspectionId` and increments
  `inspectionRound`.

Every sensitive decision writes an `AuditLog` row
(`INSPECTION_FINALIZED`, `INSPECTION_MARKED_TBD`, `INSPECTION_FOLLOW_UP_REQUIRED`,
`INSPECTION_UNDER_REVIEW`, `INSPECTION_AREAS_MERGED`). The audit **list** exposes
only the action and timestamp; human-readable reasons are shown on the inspection
detail (`tbdReason`, `completionBlockedReason`, follow-up date/tasks, finalizer).

## Merging duplicate areas (spec §16)

`POST /admin/inspections/:id/merge-areas` merges a duplicate area into another
within the **same** inspection (never across inspections). All evidence is
preserved:

- `InspectionMedia`, `InspectionPhoto`, `MediaUploadSession`, and
  `InspectionAreaStatusHistory` are reassigned from the source `inspectionAreaId`
  to the target's.
- Findings (keyed by `propertyAreaId`) for the source area are repointed to the
  target's property area.
- To keep the one-primary-video-per-area invariant, a source primary walkthrough
  is demoted to an additional labeled clip when the target already has a primary.
- The source room name is stored as a `PropertyAreaAlias` of the target so future
  move-in/move-out comparisons still match it.
- The empty source `InspectionArea` is deleted and the merge is audited.

## Web workflow

The admin inspection detail surfaces a **Finalization & follow-up** panel (status,
submitted/finalized facts, follow-up/TBD holds, and the finalize / TBD /
follow-up / request-evidence actions) and an **Inspection areas** panel with the
merge control. The Move-In Comparison, Pet Review, and Charges sections land with
Phases 5–6.
