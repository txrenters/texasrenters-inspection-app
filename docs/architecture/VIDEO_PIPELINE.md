# Video Pipeline

The selected inspection area is fixed before capture. The API verifies area approval, inspection membership, and technician assignment before issuing an idempotent short-lived upload session. Registration stores one `inspectionAreaId`; no multi-room media link exists.

Mock mode simulates provider upload and immediately runs processing. Cloudflare Stream will later implement resumable direct upload, signed playback, verified webhooks, retry states, and private media. Exact original-file archival and retention remain business/legal TODOs.
