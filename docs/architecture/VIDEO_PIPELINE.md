# Video Pipeline

The selected inspection area is fixed before capture. The API verifies area approval, inspection membership, and technician assignment before issuing an idempotent short-lived upload session. Registration stores one `inspectionAreaId`; no multi-room media link exists.

## Primary walkthrough vs. additional labeled videos

Each area keeps **exactly one primary walkthrough video** (`recordingType = PRIMARY_AREA`), enforced by a partial unique index (`InspectionMedia_primary_area_key` on `inspectionAreaId WHERE recordingType = 'PRIMARY_AREA'`). Re-recording the primary replaces only the previous primary row and marks the area complete.

A technician can also capture **additional labeled clips** (`recordingType = ADDITIONAL_ISSUE`) for the same area — extra damage, an appliance test, plumbing/electrical/pest/pet evidence, etc. — via `POST /technician/rooms/:roomId/videos`. Each carries a required `label`, an optional `category`, an optional `relatedFindingId` (validated to belong to the same inspection + property area, else `422 FINDING_NOT_IN_AREA`), and the client's guideline version. Additional clips:

- never replace the primary and never complete or advance the area;
- are transcribed/analyzed **independently** (queued per media id);
- still gate `advanceInspection` — the inspection only moves `PROCESSING → REVIEW_REQUIRED` once every media row for the inspection (primary **and** additional) has finished processing.

Mock mode simulates provider upload and immediately runs processing. Cloudflare Stream will later implement resumable direct upload, signed playback, verified webhooks, retry states, and private media. Exact original-file archival and retention remain business/legal TODOs.
