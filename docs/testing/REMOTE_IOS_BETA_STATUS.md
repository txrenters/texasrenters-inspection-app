# Remote iOS Beta — Implementation Status

Temporary remote-beta environment for US technicians while the Apple Developer account is
under review. **Not production.** No TestFlight, no EAS Build.

Resume by reading this file, checking `git status`, then starting at **§22 Exact next step**.

## 1. Expo SDK version

**54.0.36** · React Native **0.81.5**.

## 2. Package manager

**pnpm** (workspace root lockfile).

## 3. Expo Go compatibility classification

**`EXPO_GO_PARTIALLY_COMPATIBLE`**

Every native module is a first-party Expo package bundled in the Expo Go binary, and every
config plugin (`expo-router`, `expo-secure-store`, `expo-sqlite`, `expo-notifications`,
`expo-video`, `expo-camera`) is first-party. No custom native code exists.

| capability | module | Expo Go |
|---|---|---|
| Camera preview / recording / mic | `expo-camera` 17.0.10 | ✅ |
| Motion, gyroscope, magnetometer | `expo-sensors` ~15.0.8 | ✅ |
| Secure token storage | `expo-secure-store` 15.0.8 | ✅ |
| File system | `expo-file-system` ~19.0.23 | ✅ |
| Offline store | `expo-sqlite` 16.0.10 | ✅ |
| Video playback / thumbnails | `expo-video`, `expo-video-thumbnails` | ✅ |
| Haptics, linking, document picker | `expo-haptics`, `expo-linking`, `expo-document-picker` | ✅ |
| Reanimated / Screens / Safe Area / SVG | RN libs bundled in Expo Go | ✅ |
| NativeWind + RN Primitives | JS-only, no native code | ✅ |
| **Remote push notifications** | `expo-notifications` ~0.32.17 | ❌ **not supported in Expo Go since SDK 53** |
| Local / scheduled notifications | `expo-notifications` | ✅ |

**The one gap:** `getExpoPushTokenAsync` in `src/realtime/TechnicianRealtimeProvider.tsx`
cannot obtain a push token in Expo Go. The call is already wrapped in `try/catch` and returns
`undefined`, so the app degrades gracefully — testers simply will not receive server-initiated
push. Assignment notifications scheduled locally still work. Deferred until the Apple
Developer account clears and a signed build is possible.

- [x] Compatibility inspected
- [x] Limitation documented, production implementation preserved

## 4. Metro tunnel status

- [x] `@expo/ngrok` present
- [x] Scripts added — `mobile-app`: `start:tunnel` = `expo start --tunnel --go`,
      `start:tunnel:clear` = `… --clear`
- [!] **Not yet verified end-to-end.** See §16.

## 5. Backend Docker status

- [x] Existing multi-stage `backend/Dockerfile` reused and improved
- [x] `HOST=0.0.0.0` (containers must not bind loopback)
- [x] `HEALTHCHECK` added — liveness only, so health never depends on Supabase/Cloudflare
- [x] **OpenSSL installed in both stages** — `node:24-bookworm-slim` omits it and Prisma logged
      `failed to detect the libssl/openssl version … defaulting to openssl-1.1.x`. Verified
      resolved (warning count 0 after the fix).
- [x] Root `.dockerignore` hardened — the build context is the repo root, so `backend/.dockerignore`
      never applied. Now excludes `**/.env.*` (keeping `*.example`), `mobile-app`, `web-app`,
      `docs`, `supabase`, media and IDE files.
- [x] Image builds clean

## 6. Backend health-check status

- [x] `/api/v1/health` (liveness), `/api/v1/health/readiness`, `/api/v1/health/database` already
      existed; prefix is `api` + URI versioning default `1`.
- [x] **Fixed a boot-blocking bug** — see §21.
- [x] 5 new tests in `backend/src/health/health.controller.spec.ts`

## 7. ngrok container status

- [x] `compose.remote-beta.yml` service using `ngrok/ngrok:latest`
- [x] Targets `http://backend:${PORT}` over the Compose network
- [x] `depends_on: backend: condition: service_healthy`
- [x] Agent API bound to **`127.0.0.1:4040`** only
- [x] `NGROK_AUTHTOKEN` required via `${NGROK_AUTHTOKEN:?…}` — fails fast rather than starting
      an unauthenticated tunnel. Confirmed present in `backend/.env.local`.
- [!] **Not started** — needs a live session (see §16)

## 8. Public backend URL status

- [!] Not yet obtained — requires a live `pnpm remote-beta` session.

## 9. Mobile environment status

- [x] `EXPO_PUBLIC_APP_ENV` added; existing `EXPO_PUBLIC_API_BASE_URL` retained (the repo's
      established name — the brief's `EXPO_PUBLIC_API_URL` would have been a second source of truth)
- [x] `validateRemoteBetaApiUrl()` in `mobile-app/src/config/environment.ts` rejects: missing
      value, non-HTTPS, `localhost`/`127.0.0.1`/`::1`/`0.0.0.0`, Docker service names, private
      IPv4, private IPv6. Non-fatal in dev so a stale URL never destroys captured work.
- [x] 12 new cases in `mobile-app/tests/environment.test.ts`

## 10–15. Runtime verification

| item | state |
|---|---|
| Authentication test | [ ] needs a live session |
| Supabase connectivity | [ ] needs a live session |
| Stream upload | [ ] needs a live session · note `VIDEO_PLATFORM_PROVIDER=mock` |
| R2 upload | [ ] needs a live session · `INSPECTION_MEDIA_STORAGE_PROVIDER=r2` |
| Webhook | [ ] needs public URL |
| Offline behaviour | [ ] needs a device session |

## 16. External-network test status

- [ ] **Not performed.** Requires a physical iPhone on cellular data. Checklist is in
      `REMOTE_IOS_BETA_RUNBOOK.md` §External test. **Cannot be claimed from the repository.**

## 17–20. Validation

| check | result |
|---|---|
| Backend lint | **pass** |
| Backend typecheck | **pass** |
| Backend tests | **pass — 33 suites / 245 tests** |
| Backend Docker build | **pass** |
| Compose config | **pass** (`docker compose config`, exit 0) |
| Mobile lint | **pass** |
| Mobile typecheck | **pass** |
| Mobile tests | **pass — 18 suites / 94 tests** |

## 21. Known blockers

### [x] RESOLVED — uses the existing backend/.env.local

An earlier revision introduced `.env.remote-beta.local` files that duplicated every
credential. Removed. Compose now reads `backend/.env.local` for both interpolation
(`NGROK_AUTHTOKEN`) and the backend runtime environment. `docker compose config` validates
against it, exit 0.

**Compose overrides, deliberately narrow:** `HOST=0.0.0.0`, `APP_ENV=remote-beta`,
`CACHE_ENABLED=false` (Redis is on localhost, unreachable inside a container),
`USE_MOCK_AUTH=false` (safety net). `NODE_ENV` is **not** overridden — the file sets
`development`, and the configured mock video/transcription/AI providers are registered only
outside production, so forcing production would fail DI.

### [x] FIXED — production builds could not boot

`HealthController` injected `VerticalSliceService` unconditionally, but `app.module.ts:36`
registers that provider only when `NODE_ENV !== 'production'`. Every production build failed
with an unresolvable-dependency error at startup. This had gone unnoticed because the backend
is normally run in development mode.

Fixed by making the injection `@Optional()` and omitting `providers` from the readiness payload
when the stack is absent. Guarded by a regression test.

### [x] FIXED — Prisma OpenSSL warning in the slim image

See §5.

## 22. Exact next step

1. Confirm `NGROK_AUTHTOKEN` is present in `backend/.env.local` (it is).
2. `pnpm remote-beta` — builds, waits for health, resolves the public URL, verifies it, writes
   `mobile-app/.env.local`, then starts the Metro tunnel.
3. Run the external cellular checklist in the runbook on a physical iPhone.
4. Report Stream/R2/webhook results back into §10–15.

**Next command:** `pnpm remote-beta`
