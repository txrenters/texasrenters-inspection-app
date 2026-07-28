# Media storage

**Active backend: Cloudflare R2** (both `inspection-media` and `floor-plans`,
private buckets). Supabase is used for Postgres and Auth only — it no longer
stores media.

Room videos, inspection photos, and floor plans are stored as objects behind a
single abstraction (`backend/src/common/object-storage.ts`) with three
interchangeable backends.

| Provider | Where bytes live | Durable? | Signed URLs |
|---|---|---|---|
| `local` | container disk (`.local-inspection-media/`, `.local-floor-plans/`) | **No** | No |
| `supabase` | private Supabase Storage buckets | Yes | Yes |
| `r2` | Cloudflare R2 (S3-compatible) | Yes | Yes |

> **`local` is development-only.** The container's disk is ephemeral — every
> uploaded video, photo, and floor plan is destroyed on redeploy. The provider
> env vars are validated as enums so a typo cannot silently fall back to it.

Selected per media class:

```
INSPECTION_MEDIA_STORAGE_PROVIDER=local|supabase|r2   # videos + photos
INSPECTION_MEDIA_STORAGE_BUCKET=inspection-media
FLOOR_PLAN_STORAGE_PROVIDER=local|supabase|r2          # floor plans
FLOOR_PLAN_STORAGE_BUCKET=floor-plans
# Required when either provider is r2 (R2 > Manage R2 API Tokens, Object Read & Write):
R2_ACCOUNT_ID=  R2_ACCESS_KEY_ID=  R2_SECRET_ACCESS_KEY=
```

**Storage keys are identical across backends**, so switching providers never
requires a database change — only copying objects.

## Why R2 rather than Cloudflare Stream

Stream bills per **minute of video stored, every month**; R2 bills per **GB**
with **zero egress**. For an inspection archive, which only accumulates and is
rarely re-watched, that compounds: roughly **$5.40 vs $0.81 per inspection over
three years**, and the gap widens indefinitely.

Two further reasons specific to this system:

- The AI pipeline needs the **original bytes** — `media-processing.service.ts`
  extracts audio with ffmpeg for transcription. R2 egress is free; Stream would
  bill delivery for every transcription and only returns originals when the video
  was created with `downloadable: true`.
- Cloudflare removes Stream videos if the subscription lapses for 30 days. Footage
  backing a tenant charge may be needed long after the fact.

Stream's advantages — transcoding, adaptive HLS, thumbnails, a player — are not
used here: reviewers watch short clips on desktop, and the browser now streams
the original directly.

## Keys

| Media | Key format |
|---|---|
| Room video | `{organizationId}/{inspectionId}/{areaId}/videos/{uuid}.{ext}` |
| Photo | `{organizationId}/{inspectionId}/{areaId}/photos/{uuid}{ext}` |
| Floor plan | `{organizationId}/{buildingId}/{planId}/{fileName}` |

### `storageKey` vs `providerMediaId`

`InspectionMedia` carries both, and they mean different things:

- **`providerMediaId`** — identity. Derived from the mobile client's idempotency
  key, so a retried upload is recognised rather than duplicated. Unique.
- **`storageKey`** — location. Where the bytes are in the bucket.

They used to be the same value, which forced video keys to be flat and untenanted
and would have blocked any storage change. Migration `202607250007_media_storage_key`
added `storageKey` and backfilled it from `providerMediaId`, so existing objects
never had to move; new uploads get tenant-scoped keys.

## Playback

`GET /api/v1/admin/media/:mediaId/playback` returns `{ url, mimeType, expiresAt }`
with a 15-minute signed URL. The browser streams from the storage CDN directly,
which supports **range requests** — reviewers can seek without downloading the
whole file, and the API never proxies video bytes.

For the `local` backend `url` is `null`, and the player falls back to
`GET /api/v1/admin/media/:mediaId/content`, which proxies bytes. Buckets stay
**private**; access is always via short-lived signed URLs.

## Thumbnails

Each video gets a poster frame, generated with **ffmpeg** during the existing
processing pass — the video bytes are already in memory there for audio
extraction, so no extra download is needed. A frame is taken 1 second in (falling
back to the first frame for very short clips), scaled to 640px wide, and written
beside the video.

The key is **derived, not stored**: `thumbnailKeyFor(storageKey)` →
`<storageKey>.thumb.jpg`. A thumbnail is regenerable from its video, so it needs
no database column and cannot drift out of sync with one. Generation is
best-effort — any failure is logged and skipped, never interrupting transcription
or analysis, and the player simply renders without a poster.

`GET /admin/inspections/:id/media` returns a signed `thumbnailUrl` per item
(signing is local crypto for R2, so no network round trip). The web player uses it
both as the `<video poster>` and as a preview in the pre-load state, so reviewers
can recognise a room before downloading anything.

Cloudflare **Media Transformations** was evaluated and rejected: it requires a
publicly reachable source, and these buckets must stay private. Fronting R2 with a
Worker would have added infrastructure to replicate what ffmpeg — already a
dependency — does locally for free.

Photos follow the same derived-key convention for width-limited copies —
`<storageKey>.w<width>.jpg`, generated on first request and cached thereafter.
See [INSPECTION_REPORT.md](INSPECTION_REPORT.md#photo-sizing).

Backfill for videos predating this feature:

```bash
node --env-file-if-exists=.env.local scripts/backfill-video-thumbnails.mjs --apply
```

## Migration scripts

Both are dry-run by default, skip objects already present, and are safe to re-run.

```bash
# local disk → Supabase (walks the local directories)
node --env-file-if-exists=.env.local scripts/migrate-local-media-to-supabase.mjs --apply

# current provider → R2 (driven by database references)
node --env-file-if-exists=.env.local scripts/migrate-storage-to-r2.mjs --apply
```

The R2 script enumerates objects from `InspectionMedia.storageKey`,
`InspectionPhoto.storageKey`, and `PropertyFloorPlan.storageKey` rather than by
listing buckets, so exactly what the application can reference is migrated and
orphans are ignored. A source object that cannot be read is reported and counted,
never fatal.

**Cut-over order:** run the migration *before* flipping the provider — the script
copies rather than moves, so the old backend keeps serving until the switch.

## Webhooks

R2 needs none: uploads are synchronous and there is no asynchronous encoding step.
The `WebhooksController` and `WebhookSignatureGuard` remain wired to the in-memory
development stack and are not registered in production. If Cloudflare Stream is
ever adopted, that guard needs rewriting — it expects `x-webhook-signature` over
the raw body, while Cloudflare sends `Webhook-Signature: time=…,sig1=…` over
`<time>.<body>` — and the unused `WebhookEvent` table (which already has the right
`@@unique([provider, providerEventId])`) should become the durable idempotency
store.
