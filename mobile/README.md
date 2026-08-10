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

A device reaches the backend through the Cloudflare Tunnel, never the LAN.
`pnpm start` sets `EXPO_PUBLIC_API_BASE_URL` from `CLOUDFLARE_TUNNEL_HOSTNAME` in
`backend/.env.local`, so the value in this file only matters for a simulator
running on the same machine as the backend.

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
| `EXPO_PUBLIC_API_BASE_URL` | — | tunnel hostname | public HTTPS API |

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
pnpm lint:mobile
pnpm typecheck:mobile
pnpm test:mobile
pnpm build:mobile
```

There is one way to start Metro, and it always goes through the tunnel. `pnpm
start` reads two published hostnames from `backend/.env.local` and hands them to
Expo: `CLOUDFLARE_TUNNEL_HOSTNAME` becomes the API origin, and
`CLOUDFLARE_METRO_HOSTNAME` becomes `EXPO_PACKAGER_PROXY_URL`, so the manifest,
bundle and Fast Refresh are served over the tunnel too.

They must be different hostnames. The API host answers 404 for every path Metro
needs, so pointing both at it leaves Expo Go unable to download the app with
nothing explaining why — the script refuses to start rather than let that happen.

For a cold start, use `pnpm remote-beta -- --clear` from the repository root.
When the current Docker gateway is already running, enter `mobile` and
use `pnpm start:clear`.

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
