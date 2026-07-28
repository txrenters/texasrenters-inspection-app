# Media lazy loading

Nothing on the evidence screen downloads media until it is needed, and no
gallery ever downloads an original.

## Photos

`LazyPhoto` fetches nothing until an `IntersectionObserver` reports the tile
within 200px of the viewport, then requests a **bounded variant**:

```
GET /api/v1/admin/photos/:id/content?w=320
```

`w` is validated against `ALLOWED_PHOTO_WIDTHS`; anything else serves the
original. The resized copy is cached in object storage beside the original under
a derived key (`<storageKey>.w320.jpg`), so the re-encode happens once per photo
rather than once per view. A failed cache write is swallowed — the bytes are
already in hand.

### What this fixes

The previous gallery ran, for every photo, on mount:

```tsx
void apiBlob(photo.contentPath)   // full-resolution original
```

No viewport check, no width, no pagination, and proxied through the API rather
than the CDN. On a photo-heavy inspection that is hundreds of megabytes before
anything renders.

> The development database holds 7 photos averaging 0.09 MB (video-frame
> snapshots), so the defect is not visible there. It is a scale defect, provable
> from the code path rather than from current data.

## Recordings

A recording renders as a **poster frame, duration and status**. No `<video>`
element exists until the reviewer presses Play, and no playback URL is minted
until then:

1. Card shows `thumbnailUrl` (signed poster) — one signature per recording.
2. On Play, `GET /admin/media/:id/playback` returns a 15-minute signed CDN URL
   supporting range requests, so seeking does not download the whole file.
3. Local-disk storage returns no URL, and the card falls back to proxied bytes.

Only one player is active at a time: opening a second recording unmounts the
first, disposing its element and listeners rather than leaving several players
buffering.

## Area bundles

Evidence is cached per area id (`['admin','inspection',id,'area-evidence',areaId]`).
Returning to an area already opened is served from cache. Each detail panel is
keyed by area id, so a slow response for one area can never paint over the area
the reviewer is currently looking at.
