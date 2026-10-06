# Move-in vs move-out comparison

For every move-out inspection the platform draws a comparison against the
matching move-in baseline (spec §12). It is drawn from the technicians' checklists
and from the findings the office **confirmed** from the recordings. Nobody approves
it (2026-10-07): the office reviews the recordings and confirms or rejects the
AI's findings on the inspection page, and the comparison follows. A comparison
never charges anything; charges have their own review.

## When it runs

- `MediaProcessingService.advanceInspection` draws it when a **move-out** reaches
  `REVIEW_REQUIRED` (every recording processed), and a re-run of the AI redraws it.
- `ComparisonService.current` runs wherever it is read — the console, the report
  preview, a share link, issuing a link. It draws the first one once the move-out
  is submitted, and redraws one whose evidence has moved since (`staleness`): a
  checklist answer changed, a room added, a later move-in, a finding confirmed,
  rejected or added, a photograph or recording added, or the rules changed
  (`COMPARISON_RULES`, stored in `metadata.rules`).
- Redraws are serialized per move-out with `pg_advisory_xact_lock`. Each writes an
  `INSPECTION_COMPARISON_GENERATED` audit row with no actor (`system: true`).

## Baseline resolution

Always the **latest** qualifying `MOVE_IN` (`baselineWhere`): same building, unit
and lease, dated before the move-out, submitted or later. The creation-time
`baselineInspectionId` link is not used. Null unit/lease values match only null
values. With no baseline, drawing fails with `MOVE_IN_BASELINE_NOT_FOUND`; reads
answer "no comparison yet" without logging it.

## Area matching (deterministic first)

| Method | Basis | Confidence |
|---|---|---|
| `LOCAL_AREA_ID` | same catalog property-area id | 1.0 |
| `APPROVED_ALIAS` | a `PropertyAreaAlias` links the names (either direction) | 0.9 |
| `NORMALIZED_NAME` | trimmed, case-insensitive, whitespace-collapsed name equality | 0.8 |
| `AREA_CATEGORY` | same category **and** floor, only when exactly one candidate | 0.5 |

Unmatched move-out areas → `MISSING_BASELINE`; move-in areas with no move-out
counterpart → `MISSING_MOVE_OUT_EVIDENCE`. Matches are one-to-one.

## Classification

Item by item where both inspections graded the same checklist items
(`comparison-items.ts`), in this order:

1. an item undamaged at move-in and damaged now, or a **confirmed** finding of new
   damage on no already-damaged item → `NEW_DAMAGE`;
2. a confirmed finding of new damage on an item already damaged at move-in →
   `WORSENED`;
3. damage on an item the move-in never graded → `NOT_COMPARABLE`;
4. only repairs → `RESOLVED`; otherwise `UNCHANGED`.

An unconfirmed AI finding moves nothing; the console notes it is waiting. The
titles of confirmed findings that made a room new or worse are stored in
`metadata.fromRecording` and listed on the report.

Where no item was graded on both sides, defects are counted (failed checklist
grades and confirmed findings): damage only at move-out → `NEW_DAMAGE` if the
move-in graded the room, else `NOT_COMPARABLE`; damage on both sides →
`NOT_COMPARABLE`; damage only at move-in → `RESOLVED`; none → `UNCHANGED`.
No rule produces `REQUIRES_REVIEW`. Overall: any `NEW_DAMAGE`/`WORSENED` →
`NEW_DAMAGE`; nothing comparable at all → `NOT_COMPARABLE`; any improvement →
`IMPROVED`; else `UNCHANGED`.

## Sharing

`ReportShareService` issues a `COMPARISON` link once a comparison exists, with no
other gate, and audits it (`REPORT_SHARE_CREATED`). The link serves the
comparison as it stands, brought current first.

## Data model

- `InspectionComparison` — one per move-out (`@unique moveOutInspectionId`);
  `moveInInspectionId`, `overallCondition`, `version`, `generator`, `summary`,
  `metadata`, `generatedAt`. `status`, `requiresReviewCount` and the review
  columns are legacy: written as `DRAFT`, `0` and null, and read by nothing.
- `InspectionAreaComparison` — per area; `classification`, `matchMethod`,
  `matchConfidence`, `summary`, `metadata` (`items`, `aiNote`, `fromRecording`).
  `requiresReview` and the override columns are legacy and no longer written.

## Web

The **Move-in vs move-out** tab shows the overall condition, each room with its
items, what is still to come (recordings processing, findings to confirm), the
comparison report, and Share. There is nothing to approve, override or
regenerate.
