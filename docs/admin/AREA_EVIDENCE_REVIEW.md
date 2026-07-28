# Area-first evidence review

The inspection detail screen is organised by **inspection area**, not by media
type. Every recording, photo, condition summary and finding is read through the
area it belongs to.

## What this replaced

The page previously rendered four page-wide sections — Room recordings, Area
photos, Room condition summaries, Findings — each fetching the whole inspection.
A reviewer checking the Foyer had to correlate its video, its photos, its
summary and its findings across four scroll positions.

Worse, `PhotoThumb` fetched each photo's **full-resolution original** on mount,
for every photo at once, proxied through the API rather than the CDN. Nothing
was lazy and nothing was bounded.

## Shape

```
Areas (list)                    Selected area (detail)
├─ Foyer      1 video · 4 photos   ├─ Condition summary
│             Findings need review ├─ Recordings   (poster until Play)
├─ Library    1 video · 1 photo    ├─ Photos       (overview / per-finding)
│             Reviewed             └─ Findings     (itemized, expandable)
└─ Front Porch  No video · 2 photos
```

The open area is held in the `?area=` query parameter, so refresh restores it,
Back steps through areas, and a reviewer can send a colleague a link to one room.

## Two queries

| Query | Carries | Never carries |
|---|---|---|
| `GET /admin/inspections/:id/area-evidence-summary` | counts, status, evidence flags, totals | any media path, poster URL or storage key |
| `GET /admin/inspections/:id/areas/:areaId/evidence` | one area's recordings, photos, findings | another area's media, transcripts, AI payloads |

Measured on a real 12-area inspection, the summary is **5,752 bytes** and a
single area bundle **1,136 bytes**.

## Derived review status

`AreaReviewStatus` is computed on read, never stored — a stored copy would need
rewriting on every media and finding transition and would be wrong the moment
one of those writes was missed.

Precedence, most urgent first:

1. `FAILED` — media processing failed; the evidence itself is broken
2. `NOT_STARTED` — nothing captured
3. `FOLLOW_UP_REQUIRED` — a reviewer asked for re-inspection
4. `ANALYSIS_PROCESSING` — still transcribing or analysing
5. `FINDINGS_NEED_REVIEW` — a decision is pending
6. `EVIDENCE_INCOMPLETE` — a **required** area with no primary walkthrough, or skipped
7. `REVIEWED` / `EVIDENCE_READY` — decided, or nothing to decide

A pending decision outranks "ready" because the area is not actually finished.
An optional area without a walkthrough is not incomplete; a required one is.

## Cost per area count

The summary uses a constant number of grouped reads regardless of how many areas
an inspection has: one area query, one media query, and three `groupBy` calls.
A 40-area property costs the same round trips as a 4-area one. Photos are
**counted**, never listed.

## Unassigned evidence

`inspectionAreaId` is `NOT NULL` on both `InspectionMedia` and
`InspectionPhoto`, so orphaned evidence cannot exist today. The summary still
reports an `unassigned` count and the UI still surfaces a banner — a guard so
that a future schema relaxation or a bulk import can never hide evidence
silently.

## Accessibility

- Area cards are `role="tab"` buttons in a vertical tablist, keyboard-selectable
  with a visible focus ring.
- Each card's `aria-label` speaks the counts and the review requirement:
  *"Foyer. Ground Floor. 1 recording. 4 photos. 3 findings. 1 finding requires review."*
- Status is always rendered as words; colour only reinforces.
- A polite live region announces the loaded area.
- `prefers-reduced-motion` disables the card transitions.

Below 900px the two panes stack rather than compress.
