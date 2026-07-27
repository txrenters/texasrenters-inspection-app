# Floor-plan area extraction

An administrator uploads a floor plan (PDF/JPEG/PNG) and runs AI extraction to
produce a draft inspection-area checklist. Areas land as `DRAFT` for human review
and approval; the AI never approves anything.

## Provider configuration

The provider, model, and enablement come from the **global Settings**
configuration (`AiProviderSettingsService.resolve`) — there is no per-property or
per-screen model selection, and the review screen must not add one. Extraction
uses whatever is currently configured.

## Output schema

Defined in `shared/src/schemas/floor-plan.ts` and validated with Zod before
anything is written to the database:

```jsonc
[
  {
    "floorName": "Ground Floor",
    "name": "Kitchen",
    "inspectionOrder": 1,
    "isRequired": true,

    // Optional, added in schema v2 — normalized 0..1 fractions of the
    // full source image or the specific PDF page.
    "marker": { "x": 0.54, "y": 0.16, "confidence": 0.94 },
    "boundingBox": { "x": 0.43, "y": 0.02, "width": 0.19, "height": 0.27 }
  }
]
```

The prompt asks for the approximate room centre as fractions of the full image
(x from the left edge, y from the top), explicitly forbids annotated images and
pixel coordinates, and tells the model to **omit** the marker for any room it
cannot place confidently.

### Invalid or missing markers never fail extraction

`marker` and `boundingBox` are `.optional().catch(undefined)`: an out-of-range or
malformed coordinate is discarded while the area itself is kept, as long as the
area name is valid. Such areas are created with no marker, display *Marker not
available*, and can be placed manually. The number of areas without a usable
marker is reported as `summary.markerWarnings` on the extraction result.

Only a genuinely unusable response (empty output, or an array failing the core
name/order validation) raises `422 INVALID_FLOOR_PLAN_EXTRACTION`.

## Schema version

`FloorPlanExtractionService.descriptor()` reports a `schemaVersion` that is
persisted on every `FloorPlanExtractionJob`:

| Version | Contents |
|---|---|
| `1` | `floorName`, `name`, `inspectionOrder`, `isRequired` |
| `2` | v1 + optional normalized `marker` and `boundingBox` |

Legacy `v1` jobs and the areas they created remain valid — they simply have no
coordinates and support manual marker placement. Any future extraction cache key
must include the schema version (alongside the file hash, prompt version, and
model configuration) so a cached v1 result is never reused where markers are
expected. Extraction is currently uncached.

## Persistence

`FloorPlanAdminService.extract()` writes each accepted suggestion as a `DRAFT`
`PropertyArea` with `source = 'AI_FLOOR_PLAN'`, stamping `markerX/markerY`,
`markerSource = 'AI_EXTRACTED'`, `markerConfidence`, the bounding box, and
`sourceFloorPlanId = <the plan being extracted>` so coordinates are bound to that
plan version. See [FLOOR_PLAN_AREA_MARKERS.md](./FLOOR_PLAN_AREA_MARKERS.md).

## Response boundaries

The area DTO exposes `marker`, `boundingBox`, `sourceFloorPlanId`, and
`sourcePageNumber` in a mapped shape. Raw provider payloads, prompts, private
provider settings, and internal model reasoning are never returned to clients.
