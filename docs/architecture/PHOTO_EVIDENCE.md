# Photo evidence

Photos are separate from the single primary room video. An area — and a specific
finding — may hold **many** photos, each tagged with a **capture type**. Photos
never enter the video transcription/AI pipeline.

## Model

`InspectionPhoto` (Prisma): `inspectionAreaId`, optional `findingId`,
`capturedById`, `captureType`, `sequenceNumber`, `label`, `notes`, `mimeType`,
`storageKey`/`thumbnailKey`, `width`/`height`/`sizeBytes`, `idempotencyKey`,
`capturedAt`. Bytes are stored via the content-agnostic
`InspectionMediaStorageService` (local disk or Supabase bucket), the same store
used for room videos.

### Capture types (`PhotoCaptureType`)

| type                  | Documents                                             |
| --------------------- | ----------------------------------------------------- |
| `AREA_OVERVIEW`       | The whole wall / room / structure before close-ups.   |
| `FINDING_DETAIL`      | A close view of a specific issue (links to a finding).|
| `SUPPORTING_EVIDENCE` | Extra angles, scale, serial numbers, context.         |

## Endpoints

Technician: `POST /technician/rooms/:roomId/photos` (multipart, image mime
allowlist, **idempotent** by the client key; optional `findingId` is validated
against the area), `GET /technician/rooms/:roomId/photos`,
`DELETE /technician/photos/:photoId` (own photos, blocked once the inspection is
finalized), `GET /technician/photos/:photoId/content`.

Admin: `GET /admin/inspections/:inspectionId/photos`,
`GET /admin/photos/:photoId/content` (permission-gated `inspections:read`).

## Mobile capture (offline-first)

The record screen offers three capture buttons (**Area overview / Finding
close-up / Supporting**) and a **"How to photograph"** guidance sheet (the §8
checklist). Each shot is persisted to device storage first, then uploaded with a
multipart task keyed by the snapshot id (the idempotency key). If the upload
fails the photo is kept locally and marked for retry — evidence is never lost.
Capture works mid-recording.

## Web review

The inspection detail page shows an **Area photos** gallery grouped by room, with
each photo's capture type and label.

## Open decisions (not yet encoded)

- **How many overview photos are required per area** — currently none are
  enforced; configurable validation by inspection/area type is a later phase.
- **Thumbnail generation** — `thumbnailKey` exists but thumbnails are not yet
  generated; the full image is served for now.
