# Floor-plan area markers

Each extracted area can carry a **spatial marker**: an approximate point on the
source floor plan. On the *Compare plan and extracted areas* screen, clicking a
checklist row (e.g. Kitchen) shows a square marker over that room on the original
image. The source plan is never modified and no annotated image is generated —
markers are an interactive overlay rendered above the original image.

## Normalized coordinate format

Markers are stored as fractions of the **source image (or PDF page)**, never as
rendered browser pixels (which change with device, window, and zoom):

```
markerX = 0.50   → 50% of the source image width, from the left edge
markerY = 0.25   → 25% of the source image height, from the top edge
```

Both are constrained to `0.0 … 1.0` by database CHECK constraints, by the AI
response schema, and by the update DTO. The optional bounding box
(`boundingBoxX/Y/Width/Height`) uses the same normalized range.

## Data model (`PropertyArea`)

Marker columns live on the existing `PropertyArea` table — there is no duplicate
area model. Every column is nullable, so areas extracted before markers existed
remain valid and keep their approval status.

| Column | Meaning |
|---|---|
| `markerX`, `markerY` | Normalized 0..1 position (null = no marker) |
| `markerSource` | `AI_EXTRACTED` \| `DETERMINISTIC_EXTRACTED` \| `ADMIN_ADJUSTED` \| `ADMIN_PLACED` \| `UNKNOWN` |
| `markerConfidence` | Model confidence, null for human placement |
| `markerUpdatedById`, `markerUpdatedAt` | Audit fields for the last human edit |
| `sourceFloorPlanId` | The **plan version** these coordinates belong to |
| `sourcePageNumber` | PDF page the coordinates are relative to |
| `boundingBoxX/Y/Width/Height` | Optional normalized box (extensible; unused for point markers) |

Migration: `backend/prisma/migrations/202607250006_area_spatial_markers`, mirrored
in `supabase/migrations/202607250016_area_spatial_markers.sql`.

## Source-plan version safety

Marker coordinates are meaningless on a different plan image, so every marker is
bound to the plan it was derived from via `sourceFloorPlanId`:

- AI extraction stamps `sourceFloorPlanId = <the plan being extracted>`.
- The review screen renders markers **only** where
  `area.sourceFloorPlanId === <currently displayed plan id>`.
- When a new plan is uploaded and re-extracted, its areas carry the **new** plan
  id. Old coordinates are never silently reused on the new image; historical
  extraction records and approved areas are preserved.
- An area whose marker belongs to an older plan simply displays *Marker not
  available* on the current plan and can be placed manually.

## Rendered-coordinate conversion (letterboxing)

The plan image is displayed with `object-fit: contain`, so the image is
letterboxed inside its container. Positioning a marker against the container
would misalign it against the dark checkerboard margins. The conversion is
implemented as pure functions in
`web-app/components/floor-plan/floor-plan-geometry.ts`:

```
scale     = min(containerW / naturalW, containerH / naturalH)
renderedW = naturalW * scale
renderedH = naturalH * scale
offsetX   = (containerW - renderedW) / 2
offsetY   = (containerH - renderedH) / 2

left = offsetX + markerX * renderedW
top  = offsetY + markerY * renderedH
```

Both the `<img>` and the marker overlay live inside a single wrapper that carries
`transform: translate(pan) scale(zoom)` with **`transform-origin: 0 0`**. Marker
anchors therefore track image pixels automatically under zoom/pan, and the
letterbox rect only needs recomputing when the image loads, the container
resizes, or the plan changes — not on every zoom tick. Each marker glyph
counter-scales by `1/zoom` so it keeps a constant on-screen size.

The inverse map (used for click-to-place and drag) undoes the transform before
the letterbox, which is only valid with a top-left transform origin:

```
base = (pointer − stageRect.origin − pan) / zoom
x    = (base.x − offsetX) / renderedW
y    = (base.y − offsetY) / renderedH
```

Clamping differs by gesture: **placing** ignores clicks that map outside `0..1`
(the click landed in a letterbox band), while **dragging/nudging** clamps to
`0..1` so a marker cannot leave the image. Measurements come from a
`ResizeObserver` on the untransformed stage — never the `<img>`, which sits inside
the transform and would feed zoom back into its own measurement.

## Extraction output

See [FLOOR_PLAN_EXTRACTION.md](./FLOOR_PLAN_EXTRACTION.md). In short: the model is
asked for an optional `marker: {x, y}` (and optional `boundingBox`) per area in
normalized coordinates. A missing or out-of-range marker is **dropped** — the area
is still created, the marker shows as unavailable, and the extraction does not
fail. The count of such areas is reported as `summary.markerWarnings`.

## Marker editing

Marker placement from AI is a **draft suggestion**. Administrators with
`properties:manage` can correct it:

1. Select the area → **Adjust marker** (or **Place marker** when none exists).
2. Drag the marker, click the correct point on the plan, or nudge with the arrow
   keys (Shift = larger steps).
3. **Save position** persists; **Cancel** discards.

Coordinates are **not** persisted during drag — only on explicit save, via
`PATCH /api/v1/admin/property-areas/:areaId/marker` with normalized `{x, y}`.
`markerSource` becomes `ADMIN_PLACED` (no prior marker) or `ADMIN_ADJUSTED`, and
the marker audit fields are updated.

## Approval separation

Marker selection and marker adjustment are **completely separate** from area
approval:

- Clicking an area does not approve, reject, or change required/optional status.
- Saving a marker never writes `PropertyArea.status`.
- Areas approved before markers existed keep their approval; they display
  *Marker not available* and offer *Place marker*.

## Multi-floor and PDF behaviour

Markers are associated with an area, its floor, the source plan version, and
(for PDFs) a page number. The checklist groups areas by floor, and only markers
belonging to the displayed plan version are rendered — coordinates from different
plans or pages are never combined.

**PDF plans** are supported: `usePdfPageImage` renders the selected page to an
offscreen canvas with `pdf.js` (dynamically imported, so it is only downloaded for
PDFs) and feeds the raster through the *same* `<img>` path used by image plans.
Because the raster is a uniform scale of the page, normalized coordinates are
exactly page-relative and every piece of geometry, zoom, and editing logic is
shared — there is no parallel PDF code path.

Multi-page PDFs get a page selector. Markers are filtered to
`sourcePageNumber === activePage` (a legacy marker with no recorded page is
treated as page 1), placing a marker records the active page, and changing pages
clears the selection so a marker is never shown against the wrong page.

Only formats that can be rasterized support markers; anything else falls back to a
plain embed with *Markers are unavailable for this file type*.

## Backfilling legacy extractions

`POST /api/v1/admin/floor-plans/:floorPlanId/retry-missing-markers`
(`properties:manage`) re-runs extraction for a plan and fills in coordinates for
areas that have none (or whose marker belongs to an older plan version), matching
suggestions to existing areas by floor + name. It writes **only** marker and
bounding-box columns — names, inspection order, required flags, and approval
status are never touched, and areas that already have a marker for the plan are
skipped. If nothing needs backfilling, extraction is not run at all. The result
reports `{ updated, unmatched }` and the operation is audited as
`AREA_MARKER_GENERATED`.

## Audit events

`AREA_MARKER_PLACED`, `AREA_MARKER_MOVED`, and `AREA_MARKER_GENERATED` are written
to `AuditLog` with the previous coordinates, the new coordinates, the actor, the
timestamp, and `sourceFloorPlanId`. No provider prompts, payloads, or secrets are
stored.

## Testing

- `web-app/components/floor-plan/floor-plan-geometry.test.ts` — pure math: contain
  rect, forward/inverse mapping, zoomed round-trips, letterbox rejection, focus
  and nudge scaling.
- `web-app/components/floor-plan/floor-plan-canvas.test.tsx` — overlay behaviour:
  marker position under letterboxing, marker↔checklist selection, show-all,
  click-to-place, keyboard nudge, PDF unavailability, save-on-explicit-save only.
- `backend/test/floor-plan-markers.spec.ts` — schema accepts valid markers and
  drops out-of-range ones without failing the area; marker updates set the right
  source, bind the plan version, audit, and never touch approval status.

jsdom has no layout engine, `ResizeObserver`, or `PointerEvent`; `vitest.setup.ts`
polyfills the latter two and tests stub `naturalWidth/Height`, `clientWidth/Height`
and `getBoundingClientRect`.
