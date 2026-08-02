# Readiness review — 2026-08-02

Static review of `mobile/` and `web-app/` plus the backend they depend on.
Findings are grouped by phase, ordered so that each phase unblocks the next.

**Scope caveat, stated up front:** almost nothing below could be verified against
a running system, because the database is empty and every technician request
currently fails. Items marked **[unverified]** are reasoned from source, not
observed. Items marked **[confirmed]** were reproduced.

---

## Phase 0 — Blockers. Nothing else can be verified until these clear

| # | Item | Evidence |
|---|---|---|
| 0.1 | **Database is empty.** Every technician request 500s on `The table public.UserRoleAssignment does not exist`. `Inspection` has 9 columns where the schema expects ~30; 28 tables exist where the schema expects ~50; all row counts are 0. | **[confirmed]** — queried through the backend's own Prisma client |
| 0.2 | **`_prisma_migrations` has 2 rows, both written by me.** The prior history is gone, so migration state no longer describes the database. | **[confirmed]** |
| 0.3 | **HVAC migration is marked applied but its SQL failed** (`type "InspectionType" does not exist`). I ran `migrate resolve --applied` before confirming success — my error. That row is wrong and must be removed before any replay. | **[confirmed]** |
| 0.4 | Decide the authoritative database: restore from Supabase PITR, or accept the empty one and replay migrations. **Do not replay before deciding** — replaying makes an empty database look healthy and hides that a restore was possible. | — |

## Phase 1 — Correctness gaps already found but not closed

| # | Item | Notes |
|---|---|---|
| 1.1 | **Upload progress sits at 0%** for the whole transfer, then jumps to done. Live progress is wired (`useLiveUploadProgress`, ids match, store replaces the array) but was never observed working on a long enough upload. | **[unverified]** — needs one 60s+ upload |
| 1.2 | **iOS 360°/gyro guidance stopped working** after the `isAvailableAsync` change. Hook logic reads correct on inspection; cause unknown. Diagnostics panel exists for exactly this — Settings → Diagnostics → Motion sensor. | **[unverified]** |
| 1.3 | **Server-side frame extraction never run end-to-end.** ffmpeg verified inside the container and the exact args produce a frame, but no marked recording has been through the pipeline. | **[unverified]** |
| 1.4 | **Checklist ticks do not persist.** State is `useState` in the camera screen — leaving the screen loses coverage. Needs to move into the device store, then to the server. | **[confirmed]** by inspection |
| 1.5 | **Checklists are still mock data.** Table `AreaChecklistItem` exists; no admin API, no web UI, and the mobile client still generates lists from the area name. | **[confirmed]** |
| 1.6 | **Voice → checklist matching is unwired.** `matchChecklistMentions` is written and tested but nothing calls it. Needs the live-vs-transcript decision (live requires an EAS dev build). | **[confirmed]** |
| 1.7 | **"A summary for every area" is detection only.** `summaryCoverage` surfaces areas that finished without one; nothing retries a failed analysis or lets an area be re-summarised. | **[confirmed]** |

## Phase 2 — Security

Two things worth saying plainly, because they came out clean:

- **No secret is exposed to either client.** Every `EXPO_PUBLIC_*` and
  `NEXT_PUBLIC_*` variable is a URL, an app-env flag, or the Supabase **anon**
  key — which is designed to be public. Service-role key, R2 credentials, JWT
  secret and webhook secrets are backend-only. **[confirmed]**
- **Authorization is enforced server-side, not in the client.** The technician
  controller is `@UseGuards(ApiAuthGuard, RolesGuard)` + `@Roles(INSPECTION_TECHNICIAN)`;
  the admin controller is `@UseGuards(ApiAuthGuard, PermissionsGuard)`. The web
  app's role checks drive *labels*, not access. **[confirmed]**

Outstanding:

| # | Item | Severity |
|---|---|---|
| 2.1 | **Revoke the Cloudflare Stream API token.** Live credential in `backend/.env.local` that nothing uses — Stream is dead config; video goes to R2. | Medium |
| 2.2 | **Remove the RapidNative CORS origins** from `backend/.env.local`. Temporary, and nothing in the repo records that they must go. | Medium |
| 2.3 | **Audit `web-app`'s 56 `'use client'` components** for any that fetch privileged data client-side rather than through a server component. Not reviewed in depth. **[unverified]** | Medium |
| 2.4 | **No rate limiting observed** on the technician upload endpoints. A stolen token could push 2 GB videos repeatedly. **[unverified]** | Medium |
| 2.5 | Confirm the mobile client cannot reach admin-only routes even if a token carries both roles. | Low |

## Phase 3 — Performance

| # | Item | Notes |
|---|---|---|
| 3.1 | **Audit remaining endpoints for serial round trips.** `createArea` took 13.7s across 37 statements purely from issuing independent queries in series — fixed, but the same pattern likely exists elsewhere. The pooler costs ~375ms per round trip, so this is the dominant cost, not query complexity. | High value |
| 3.2 | **Supabase pooler latency is the bottleneck.** Worth measuring whether `DIRECT_URL` (5432) materially beats the pooler (6543) for the backend's own traffic. | High value |
| 3.3 | **Video upload buffers through nginx** (`proxy_request_buffering` on). The phone reaches 100% then waits while nginx forwards and the backend pushes to R2 — this is what "stuck at 99%" felt like. R2 writes now stream, but the buffering stage remains. | Medium |
| 3.4 | **Supabase Storage path still buffers whole files** into memory (`putBuffer`). Only R2 was converted to streaming. Irrelevant while R2 is the provider; a trap if it ever changes. | Low |
| 3.5 | **`web-app/.next-dev` reached 682 MB.** Cleared, but worth understanding why it grew that far. | Low |

## Phase 4 — UI / UX

Also came out better than expected: every `Pressable` found carries an
`accessibilityLabel`, no touch target under 44pt was found, and status is
conveyed in words as well as colour throughout. **[confirmed]**

| # | Item | Notes |
|---|---|---|
| 4.1 | **Camera layout values were reasoned, not measured.** `pt-36`/`pb-60` and the grid at 42% were derived from scrim heights on paper. Needs checking on a short phone and a tablet. `archive/camera-rebuild` contains a `camera-layout.ts` that solved this properly — worth reading. | Medium |
| 4.2 | **"0 photos" appears twice** on the camera — in the snapshot row and under the shutter. | Low |
| 4.3 | **Reduce-motion covers the loader and skeletons only.** Press-state scale animations (`active:scale-[0.98]`) still animate. | Low |
| 4.4 | **No offline banner for a failed mutation.** Reads fall back to cache; writes surface as an error with no "will retry" affordance. | Medium |
| 4.5 | **Diagnostics is reachable only through Settings.** Fine, but the motion test is the main tool for the open gyro bug — worth a direct link while that is unresolved. | Low |

## Phase 5 — Functionality to finish

| # | Item |
|---|---|
| 5.1 | Admin checklist CRUD API + web UI (the feature Phase 1.5 is blocked on) |
| 5.2 | Mobile consumes real checklists, falling back to generated ones when an area has none |
| 5.3 | Decide live speech (EAS dev build) vs transcript matching (works today, delayed) |
| 5.4 | Re-run a single area's AI summary from the app |
| 5.5 | Simultaneous-capture policy: is one technician on two devices a workflow to support or an accident to prevent? Today the second device's primary video silently replaces the first |
| 5.6 | Per-area audit view distinct from the findings list, if that is what "audit" should mean |

## Testing

| Package | Files | Tests |
|---|---|---|
| `mobile/` | 18 | 160 |
| `backend/` | 33 | 260 |
| `web-app/` | 14 | — |

Gaps: no end-to-end test covers upload → transcription → summary; no test
asserts a technician cannot reach admin routes; `web-app` has the thinnest
coverage of the three.

---

## Suggested order

1. **Phase 0** — decide the database. Everything else is unverifiable until then.
2. **Phase 1.1–1.3** — one device session closes three unknowns at once: record a
   long walkthrough on Android with a few shutter taps, and check the motion
   panel on iOS.
3. **Phase 2.1–2.2** — revoking a credential takes minutes.
4. **Phase 5.1–5.2** — the checklist feature, now that the table exists.
5. **Phase 3.1** — endpoint round-trip audit, once there is data to measure against.
