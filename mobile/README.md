# TexasRenters Inspection — technician app

This package is the redesigned Expo technician application. It keeps the visual
work from the supplied prototype while using the same production architecture as
`mobile`:

- technician authentication against the TexasRenters API, with mandatory
  first-login password change
- authenticated TexasRenters REST API calls only
- locally durable room recordings and snapshots
- resumable background upload queue
- Socket.IO assignment updates and Expo notifications
- AI transcript summaries and findings returned by the backend for human review

The app never connects directly to PostgreSQL and never contains privileged
provider credentials.

## Configure

Copy `.env.example` to `.env.local` and provide:

```dotenv
EXPO_PUBLIC_API_BASE_URL=http://localhost:3000
```

On a physical device, the development environment derives the backend host from
Expo's active LAN host when `EXPO_PUBLIC_API_BASE_URL` points at localhost. An
optional `EXPO_PUBLIC_DEV_LAN_API_BASE_URL` may be supplied as a fallback; do not
commit a machine-specific IP address.

### Release builds

`.env.local` is a **development** file. EAS builds never read it — the repository
is archived from git, and it is gitignored.

`EXPO_PUBLIC_*` values are inlined into the bundle at build time, so anything not
present during the build is absent from the app permanently. `eas.json` sets the
flags that define the shape of each build (`EXPO_PUBLIC_APP_ENV` and the demo and
test toggles, pinned off for preview and production). The one value that differs
per deployment must exist as an **EAS environment variable** in the matching
environment (`eas env:create`, or Project settings → Environment variables):

| Variable | development | preview | production |
| --- | --- | --- | --- |
| `EXPO_PUBLIC_API_BASE_URL` | — | ngrok tunnel | public HTTPS API |

**The app holds no provider credential of any kind.** It authenticates against
the TexasRenters API and receives a token; nothing else. Database passwords, the
JWT signing secret, R2 keys and the Cloudflare Stream API token and signing key
are backend-only and must never appear in an `EXPO_PUBLIC_*` variable — that
prefix ships whatever it is given to every device, permanently, in a build that
cannot be recalled.

If the API address is missing or unreachable from a phone, the app now says so on
the Diagnostics screen instead of failing as unexplained network errors — see
`validateApiBaseUrl` in `src/config/environment.ts`. That check cannot run until
the build exists, so it reports the fault rather than preventing it.

## Run from the repository root

```bash
pnpm install
pnpm dev:mobile
```

V2 is the default root mobile target and uses Metro port `8082`. The legacy
client is available only through explicit `:v1` commands.

Other root commands:

```bash
pnpm dev:mobile:clear
pnpm dev:mobile:tunnel
pnpm lint:mobile
pnpm typecheck:mobile
pnpm test:mobile
pnpm build:mobile
```

Remote-beta mode discovers the live Docker gateway URL from the ngrok agent on
local port `4041`, verifies `/api/v1/health`, and injects that public origin into
Expo. One ngrok domain carries both concerns: `/api/*` and `/socket.io/*` route
to NestJS, while the Expo manifest, bundle, assets, and Fast Refresh route to V2
Metro on port `8082`. Expo does not start a second ngrok agent.

For a cold start, use `pnpm remote-beta -- --clear` from the repository root.
When the current Docker gateway is already running, enter `mobile` and
use `pnpm start:tunnel --clear`.

## Data and evidence flow

1. A technician signs in with the web-provisioned account.
2. Assigned inspections arrive through the REST API and realtime invalidation.
3. A room video is saved to the device and bound to exactly one inspection and
   one approved room.
4. Saving the review queues the evidence and immediately advances the technician
   to the next room.
5. The queue retries after connectivity returns.
6. The backend transcribes and analyzes uploaded evidence.
7. AI findings remain pending until an authorized human reviews them.

The former prototype database and fake fixtures are intentionally not included.
