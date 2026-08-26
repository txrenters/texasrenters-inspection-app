# Real-time technician positions, and daily route planning

Decisions taken: **self-hosted OSRM**, and **both console and mobile**.

## What already exists

| | |
|---|---|
| Realtime gateway | Authenticated, `organization:` rooms, **server→client only**, console already connected |
| Property coordinates | Exist as of the geocoding work — Census `INTERPOLATED`, right block, approximately right house |
| Technician positions | `TechnicianLocationPing`, written by the handset, read by the map |
| Routing | **Nothing.** The `routing` hits in the codebase are AI provider routing |
| Stop ordering | **No `sequence` column** on `InspectionAssignment` |

## Three findings that shape this

**1. `Inspection.scheduledAt` is `@db.Date` — a date with no time of day** (`schema.prisma:958`).

There are no appointment times to route around. That is what makes stop order genuinely free, and therefore worth optimising. It also means travel time can say how long the driving takes and can never say whether somebody will make a promised window, because no window exists. If the office starts promising tenants times, this becomes a scheduling problem rather than a routing one, and the plan below does not survive that change.

**2. Broadcasting to the existing organization room would leak positions.**

`technician-events.gateway.ts:111` joins that room on **`inspections:read`**. The map endpoint is gated on **`technicians:read`**, deliberately — "where a named person was at a given minute is a fact about them, not about an inspection, and the two should not open with the same key". Publishing positions to the existing room hands live employee locations to every account holding `inspections:read` and silently undoes that boundary.

**A separate room, `organization:{id}:locations`, joined only when `permissions.includes('technicians:read')`.** Non-negotiable.

**3. OSRM has no traffic data.** Times are free-flow: the road network at its speed limits. In Houston at 5pm that is optimistic, and it must be labelled an estimate in both surfaces. This is the cost of the no-key, no-billing, no-ToS choice, and it is worth being explicit about rather than letting somebody discover it while late.

## Stage 1 — Real-time positions

**Backend**
- `TechnicianEventsGateway.publishTechnicianPosition(organizationId, position)`, emitting `technician:position` to the **locations room**, following the shape of `publishOrganizationNotification`.
- `TechnicianLocationService.record()` publishes **only the newest accepted fix** of a batch. A handset back from a dead zone flushes up to 200 queued points; emitting each would fire 200 events to redraw one marker.
- Room membership in `handleConnection` gated on `technicians:read`.

**Console**
- `web/lib/realtime.tsx` listens and writes the new position into the `technicianLocations` query cache, replacing that technician's row (the query is latest-per-technician).
- The 60s poll drops to a slow safety net — a socket that silently dropped should not freeze the map for ever.
- Markers move between fixes rather than teleporting; `FitToData` must **not** refit on every position or the map fights the viewer.

## Stage 2 — OSRM

**One-shot preprocessing, not a boot step.** Extract → partition → customize on the Texas OSM extract takes tens of minutes and several GB; it must not run on every container start. Follows the existing one-shot pattern in compose (as `migrate` does), writing to a named volume, guarded so it is skipped when the `.osrm` files are already present.

- Data: Geofabrik `texas-latest.osm.pbf` (~1.4GB).
- Serve: `osrm-routed --algorithm mld`, roughly 1–2GB resident for Texas.
- **Internal only.** No published host port, reachable on the compose network — it is an unauthenticated HTTP service and must never face the internet.
- `OSRM_URL` in backend env; absent means routing is unavailable, which the API reports rather than pretending.

**The axis trap, again: OSRM takes `lon,lat`,** the opposite of how coordinates are written everywhere else in this system. This is the same mistake as the Census `x`/`y` field, which put every property in the Indian Ocean until it was caught. The coordinate formatter gets its own tested function.

## Stage 3 — Routes

**`RouteService`** — provider-independent apart from one call.
- Inputs: the technician's latest position, plus that day's assigned inspections whose property has coordinates.
- `/table/v1/driving/...` for the duration matrix from the current position across all stops.
- Ordering: **brute-force permutation up to 7 stops** (5,040 orderings, trivial), nearest-neighbour + 2-opt beyond. No solver, no dependency.
- `/route/v1/driving/...` in the chosen order for the polyline and per-leg detail.
- **Computed and advisory, never stored.** There is no `sequence` column, and adding one would assert that the technician is expected to follow this order — a dispatch policy nobody has set. Ephemeral keeps it a suggestion.
- Properties without coordinates are **listed as unroutable rather than silently dropped**; a stop missing from the route is the failure nobody would notice.

**API**
- `GET /admin/technicians/:id/route?date=` behind `technicians:read`.
- `GET /technician/route` for the technician's own day — their own position, their own stops, no permission beyond being themselves.

**Console** — the route drawn as a polyline over the existing map, plus a panel: ordered stops, per-leg drive time, total. Reuses the `--map-property` / `--map-technician` tokens.

**Mobile** — ordered stop list with drive times on the technician's day. **Cannot ship over the air**: the tree already carries `expo-location` and `expo-task-manager` at module scope against `version: 1.0.0`, so mobile needs a native build regardless.

## Verification

```
npm run typecheck && npm test        # workspace-wide
```

Pure-function tests earn their place on: the `lon,lat` formatter, the permutation ordering (a known 4-stop case with an obvious answer), the unroutable-stop partition, and the "newest fix only" batch rule. The OSRM client is tested against recorded responses, not the live service.

On-device and in-browser: a position moving on the console without a refresh, and a route that changes when the technician moves.

## Known limits, stated rather than discovered

- **Free-flow times only.** No traffic. Label as estimates.
- **Interpolated property coordinates.** Good to a block, not a driveway.
- **No appointment times exist**, so nothing here can promise arrival windows.
- Route quality is bounded by geocoding: a property that failed to geocode cannot be routed to at all.
