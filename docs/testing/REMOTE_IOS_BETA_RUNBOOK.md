# Remote iOS Beta — Developer Runbook

Temporary environment for remote US technicians while the Apple Developer account is under
review. Metro reaches phones through the Expo tunnel; the backend reaches them through a
**separate** Cloudflare Tunnel. Both must be running.

```
iPhone ── Expo Go ── Expo tunnel (ngrok) ──────────► Metro (mobile-app)
iPhone ── EXPO_PUBLIC_API_BASE_URL ── cloudflared ──► backend container ──► Supabase / Stream / R2
```

The Expo tunnel carries **only** the JS bundle, dev assets and Fast Refresh. It never exposes
the REST API — that is why the second tunnel exists.

## Prerequisites

- Docker Desktop running
- Node 24 + pnpm (workspace already uses it)
- Real Supabase / Cloudflare Stream / R2 credentials in `backend/.env.local`
  (the API tunnel needs no account — see below)
- The developer machine stays awake and online for the whole session

## One-time setup

There is **no separate remote-beta secret file** and **nothing to add**. Everything comes from
the existing `backend/.env.local`, which already holds the Supabase, Cloudflare Stream, R2 and
Propertyware credentials.

The API tunnel runs as a Cloudflare **quick tunnel**: no account, no domain, no token. It issues
a random `https://<words>.trycloudflare.com` URL on each start, which `pnpm remote-beta` reads
from the container logs and writes into `mobile-app/.env.local`.

Do **not** set `REMOTE_BETA_API_URL` unless you have a real named-tunnel hostname — a
placeholder value there makes the health check target a domain that does not exist.

`backend/.env.local` is git-ignored. **Never commit it.**

### What Compose overrides, and why

| variable | value | reason |
|---|---|---|
| `HOST` | `0.0.0.0` | loopback is unreachable from the Docker network |
| `APP_ENV` | `remote-beta` | disables Swagger on the public tunnel |
| `CACHE_ENABLED` | `false` | `REDIS_URL` points at localhost, which inside a container is the container |
| `USE_MOCK_AUTH` | `false` | safety net while publicly reachable |

`NODE_ENV` is **not** overridden. Your file sets `development`, and `app.module.ts` registers
the mock video/transcription/AI providers only outside production — forcing production would
fail dependency injection for your current `VIDEO_PLATFORM_PROVIDER=mock` configuration.

## Start (recommended)

```bash
pnpm remote-beta
```

Builds the image, waits for container health, reads the public HTTPS URL from the cloudflared
container logs, verifies `/api/v1/health` through it, writes `EXPO_PUBLIC_APP_ENV` and
`EXPO_PUBLIC_API_BASE_URL` into `mobile-app/.env.local` (leaving other keys untouched), then
starts Metro in tunnel mode. It prints no secrets.

## Start (manual fallback)

```bash
docker compose --env-file backend/.env.local -f compose.remote-beta.yml up -d --build
```

```bash
docker compose --env-file backend/.env.local -f compose.remote-beta.yml ps
```

```bash
docker compose --env-file backend/.env.local -f compose.remote-beta.yml logs -f backend tunnel
```

Get the public URL from the tunnel logs:

```bash
docker compose --env-file backend/.env.local -f compose.remote-beta.yml logs tunnel | grep trycloudflare
```

Put it in `mobile-app/.env.local`:

```
EXPO_PUBLIC_APP_ENV=remote-beta
EXPO_PUBLIC_API_BASE_URL=https://<words>.trycloudflare.com
```

Then:

```bash
cd mobile-app && pnpm run start:tunnel
```

## Status

```bash
pnpm remote-beta:status
```

## Verify the public endpoint

```bash
curl -s https://<words>.trycloudflare.com/api/v1/health
```

Expect `{"status":"ok","timestamp":"…"}`. Liveness deliberately does **not** touch Supabase, so
a healthy container never depends on external providers. For dependency state use
`/api/v1/health/readiness`.

## External cellular test — required before inviting technicians

Simulator-only testing is not sufficient for camera and portal behaviour.

1. Backend and tunnel up; public health returns 200
2. Metro running in tunnel mode
3. iPhone on **cellular data, Wi-Fi off**
4. Open Expo Go, scan the QR
5. JS bundle loads
6. Sign in with the assigned beta account
7. Assigned inspection list loads
8. Open an area
9. Create or edit a record — confirm old values do **not** flash back
10. Record a short video
11. Capture wide + focused snapshots
12. Confirm upload progress advances
13. Confirm media appears in the web app under the correct area
14. Force-close Expo Go, reopen, confirm state is still correct
15. Confirm pending uploads reach 0

## Shutdown

```bash
pnpm remote-beta:stop
```

Confirm testers have finished recording and pending uploads are 0 first. The helper runs
`docker compose … down` — **never** `down -v`. Volumes are not removed and unsynchronised
technician work is never discarded.

## Troubleshooting

| symptom | cause | action |
|---|---|---|
| `Docker is not available` | Docker Desktop not running | start it and retry |
| `NGROK_AUTHTOKEN is not set` | key missing from `backend/.env.local` | add it to that file |
| Backend `unhealthy` | bad credentials or unreachable Supabase | `logs backend`; check `DATABASE_URL` |
| `P1001 Can't reach database server` | wrong/unreachable Supabase host | verify the pooled connection string |
| Port already allocated | something else on 3000 | change `PORT` in `backend/.env.local` |
| No HTTPS tunnel found | ngrok auth failed / limit reached | `logs ngrok` |
| Phone: network error on every call | stale tunnel URL in `mobile-app/.env.local` | re-run `pnpm remote-beta`, reload Expo Go |
| Phone: `localhost` errors | `EXPO_PUBLIC_API_BASE_URL` points at loopback | the app logs `[remote-beta] …` explaining it; fix the URL |
| Push notifications never arrive | Expo Go dropped remote push in SDK 53+ | expected — needs a signed build |

## Recovery

**After a computer restart** — Docker and ngrok both stop. ngrok issues a **new** URL on a free
plan, so `mobile-app/.env.local` is stale. Re-run `pnpm remote-beta` and have testers reload
from the new QR code.

**After the ngrok endpoint changes** — same: the URL is not stable across restarts. Never
hard-code it anywhere.

## Security posture

- Authentication and role authorization stay enabled; `USE_MOCK_AUTH=false` is forced in Compose
- Swagger is **off** during remote beta (`APP_ENV=remote-beta`); opt in with `ENABLE_SWAGGER=true`
- Stack traces are never returned in a response body — the exception filter logs them and
  replies with a generic message for any 5xx, independent of `NODE_ENV`
- Backend port binds `127.0.0.1` only — ngrok is the single public entry point
- ngrok agent API binds `127.0.0.1:4040`; it shows captured request/response bodies and must
  never be published
- Supabase service-role, Stream API token, R2 keys and the ngrok token are backend-only and
  never appear in any `EXPO_PUBLIC_*` variable
