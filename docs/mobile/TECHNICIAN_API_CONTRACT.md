# Technician API contract

What the mobile app calls. **No new endpoints are needed** — all 29 already exist in
`backend/src/technician/technician.controller.ts`.

## Base URL

```
<EXPO_PUBLIC_API_BASE_URL>/api/v1/technician/...
```

Compose the URL with `resolveApiUrl` from `@texasrenters/shared` rather than string
concatenation. It accepts a base with **or** without the `/api/v1` suffix and normalises both,
so an origin-only tunnel URL and a suffixed localhost URL both work.

## Auth

Every technician route is guarded:

```ts
@UseGuards(ApiAuthGuard, RolesGuard)
@Roles(UserRole.INSPECTION_TECHNICIAN)
```

The app authenticates with **Supabase**, then sends that session's JWT:

```
authorization: Bearer <supabase access_token>
```

The backend verifies the JWT and checks the role. Two consequences for the rebuilt app:

- A user without the `INSPECTION_TECHNICIAN` role gets **403** on every route, even with a valid
  token. Test accounts must have the role assigned.
- There is no separate app login — the Supabase session *is* the credential. Get it from
  `getSupabaseClient().auth.getSession()`.

## Endpoints

### Session / device

| method | path | purpose |
|---|---|---|
| POST | `/notification-devices` | register an Expo push token |
| DELETE | `/notification-devices` | unregister |

### Inspections

| method | path | purpose |
|---|---|---|
| GET | `/dashboard` | technician home summary |
| GET | `/inspections` | assigned list — supports `status` and `search` |
| GET | `/inspections/:id` | one inspection |
| GET | `/inspections/:id/context` | property / lease / occupancy context |
| POST | `/inspections/:id/start` | begin |
| POST | `/inspections/:id/complete` | submit |
| GET | `/inspections/:id/rooms` | areas for the inspection |
| POST | `/inspections/:id/areas` | **add area** (technician-created) |
| GET | `/inspections/:id/findings` | findings list |
| GET | `/inspections/:id/report` | summary report |
| POST | `/inspections/:id/pet-observations` | pet evidence |

### Property / floor plan

| method | path |
|---|---|
| GET | `/properties/:propertyId` |
| GET | `/properties/:propertyId/floor-plan` |
| GET | `/floor-plans/:floorPlanId/content` |

### Areas (rooms)

| method | path | purpose |
|---|---|---|
| GET | `/rooms/:roomId` | area detail |
| PATCH | `/rooms/:roomId/note` | technician note |
| POST | `/rooms/:roomId/skip` | skip, with reason |
| POST | `/rooms/:roomId/complete` | mark complete |

### Media

| method | path | purpose |
|---|---|---|
| GET | `/rooms/:roomId/media` | recordings for an area |
| POST | `/rooms/:roomId/media` | register media |
| POST | `/rooms/:roomId/videos` | video upload session |
| GET | `/rooms/:roomId/photos` | snapshots |
| POST | `/rooms/:roomId/photos` | upload snapshot |
| DELETE | `/photos/:photoId` | remove snapshot |
| GET | `/photos/:photoId/content` | authorized photo bytes |
| GET | `/uploads` | upload queue state |
| POST | `/media/:mediaId/reprocess` | retry processing |

## Coverage against the mobile workflow

| screen | endpoints |
|---|---|
| Inspections list | `GET /inspections` |
| Inspection overview | `GET /inspections/:id`, `/context` |
| Area list | `GET /inspections/:id/rooms` |
| Area detail | `GET /rooms/:roomId` |
| Add area | `POST /inspections/:id/areas` |
| Note / skip / complete | `PATCH /rooms/:id/note`, `POST /rooms/:id/skip`, `/complete` |
| Recording + snapshots | `POST /rooms/:id/videos`, `/photos`, `GET /rooms/:id/media` |
| Uploads tab | `GET /uploads`, `POST /media/:id/reprocess` |
| Findings | `GET /inspections/:id/findings` |
| Report / summary | `GET /inspections/:id/report` |

Every screen in the workflow has backing endpoints. Nothing is missing.

## Reusing the existing client

The current app already implements this surface in
`mobile-app/src/repositories/api/repositories.ts` — auth header, base-URL fallback list, 15s
timeout, `AbortController` wiring, Zod response validation and the offline queue.

**Reuse that file rather than writing a new client.** Rebuilding it is where the subtle bugs
live: token refresh, GET-only fallback between base URLs, and the upload retry semantics.

## Browsing the API interactively

Swagger is served at `/api/docs` but is **disabled during remote beta** (`APP_ENV=remote-beta`)
so the public tunnel does not expose the full API surface. To browse it locally:

```bash
cd backend && pnpm dev
```

then open <http://localhost:3000/api/docs>. To expose it through the tunnel temporarily, set
`ENABLE_SWAGGER=true` in `backend/.env.local` and restart — remove it afterwards.

## Gotchas

- **`USE_MOCK_AUTH=false`** is forced by Compose during remote beta. Mock auth cannot be used to
  bypass login while the API is publicly reachable.
- **`EXPO_PUBLIC_ENABLE_DEMO_DATA`** must stay unset. When `true`, the app resolves
  `dataSource = 'mock'` and never calls the backend at all.
- **`VIDEO_PLATFORM_PROVIDER=mock`** currently, so video upload exercises the mock provider.
  Snapshot upload is real (`INSPECTION_MEDIA_STORAGE_PROVIDER=r2`).
- Never put Supabase **service-role** keys, Cloudflare tokens or R2 credentials in any
  `EXPO_PUBLIC_*` variable — those ship inside the app bundle. The anon key is the only Supabase
  value the app should hold.
