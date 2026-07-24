# Move-in vs move-out comparison

For every move-out inspection the platform drafts a comparison against the
matching move-in baseline (spec §12). The draft is **machine-generated and always
requires human review** — AI may assist in future but never finalizes a
comparison, and a comparison never auto-charges anything.

## When it runs

`MediaProcessingService.advanceInspection` drafts the comparison when a **move-out**
inspection reaches `REVIEW_REQUIRED` (i.e. after submission, once every recording
has finished processing so findings exist). Generation is best-effort — a failure
is logged and never blocks review. Administrators can also (re)generate on demand:
`POST /admin/inspections/:id/comparison/generate`.

## Baseline resolution

The move-in baseline is:

1. the `Inspection.baselineInspectionId` linked at creation, **if it is still a
   `MOVE_IN` for the same building / unit / lease**; otherwise
2. the latest submitted `MOVE_IN` before this move-out in the same
   building / unit / lease scope.

Null unit/lease values match only null values, so unit-less inspections never
match unrelated ones. If no baseline is found, generation fails with
`409 MOVE_IN_BASELINE_NOT_FOUND` (surfaced to the admin; swallowed by the trigger).

## Area matching (deterministic first)

Each move-out area is matched to a move-in area in priority order — deterministic
methods only; AI is not used yet:

| Method | Basis | Confidence |
|---|---|---|
| `LOCAL_AREA_ID` | same catalog property-area id | 1.0 |
| `APPROVED_ALIAS` | a `PropertyAreaAlias` links the names (either direction) | 0.9 |
| `NORMALIZED_NAME` | trimmed, case-insensitive, whitespace-collapsed name equality | 0.8 |
| `AREA_CATEGORY` | same category **and** floor (weak — always flagged for review) | 0.5 |

Unmatched move-out areas → `MISSING_BASELINE`; move-in areas with no move-out
counterpart → `MISSING_MOVE_OUT_EVIDENCE`. Matches are one-to-one; a move-in area
is consumed once. Unrelated areas are never silently merged.

## Classification

Per matched area, from new-damage findings (`POSSIBLE_NEW_DAMAGE`) on each side and
move-out media presence:

| Move-out | Move-in | Result | Review? |
|---|---|---|---|
| no media | — | `MISSING_MOVE_OUT_EVIDENCE` | yes |
| damage | none | `NEW_DAMAGE` | yes |
| damage | damage | `REQUIRES_REVIEW` | yes |
| none | damage | `RESOLVED` | yes |
| none | none | `UNCHANGED` | no |

Any charge-relevant call (new/resolved/uncertain damage) is flagged for human
review. Overall condition rolls up: any `NEW_DAMAGE`/`WORSENED` → `NEW_DAMAGE`;
else any review-flagged/missing → `REQUIRES_REVIEW`; else any improvement →
`IMPROVED`; else `UNCHANGED`.

## Review & override

- `POST /admin/comparisons/:id/review` `{ decision: APPROVED|REJECTED, note? }` —
  permission `comparisons:review`.
- `POST /admin/area-comparisons/:id/override` `{ classification, reason? }` —
  permission `comparisons:review`. The first machine value is preserved in
  `originalClassification`, the parent roll-up is recomputed, and the change is
  audited.

Regenerating replaces a `DRAFT`/`UNDER_REVIEW`/`REJECTED` comparison and bumps
`version`; an `APPROVED` comparison is never silently overwritten
(`409 COMPARISON_ALREADY_APPROVED`). Every generation, approval, rejection, and
override writes an `AuditLog` row (`entityType = InspectionComparison`).

## Data model

- `InspectionComparison` — one per move-out (`@unique moveOutInspectionId`);
  `moveInInspectionId`, `status`, `overallCondition`, `version`, `generator`,
  `requiresReviewCount`, review fields, `metadata`.
- `InspectionAreaComparison` — per area; `moveIn/moveOutPropertyAreaId`,
  `classification`, `matchMethod`, `matchConfidence`, `requiresReview`, and the
  override trail (`originalClassification`, `overriddenById/At`, `overrideReason`).

External links (organization, inspections, reviewer) are plain FK columns enforced
in the migration — no Prisma relations — to avoid adding back-relations across the
schema. A durable, versioned `comparison_reports` snapshot table (spec §17) is a
deferred enhancement; the current comparison record already stores its version and
generation metadata.

## Web

The admin inspection detail shows a **Move-in vs move-out** panel for move-out
inspections: overall condition, per-area classifications with match method /
confidence and review flags, generate/regenerate, approve/reject, and per-area
override.
