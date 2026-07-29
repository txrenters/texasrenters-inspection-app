# TexasRenters Technician App V2

This package is the redesigned Expo technician application. It keeps the visual
work from the supplied prototype while using the same production architecture as
`mobile-app`:

- Supabase technician authentication with mandatory first-login password change
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
EXPO_PUBLIC_SUPABASE_URL=https://your-project.supabase.co
EXPO_PUBLIC_SUPABASE_ANON_KEY=your-public-anon-key
```

On a physical device, the development environment derives the backend host from
Expo's active LAN host when `EXPO_PUBLIC_API_BASE_URL` points at localhost. An
optional `EXPO_PUBLIC_DEV_LAN_API_BASE_URL` may be supplied as a fallback; do not
commit a machine-specific IP address.

## Run from the repository root

```bash
pnpm install
pnpm dev:mobile:v2
```

V2 uses Metro port `8082` so it can run without colliding with the original
mobile app on `8081`.

Other root commands:

```bash
pnpm dev:mobile:v2:clear
pnpm dev:mobile:v2:tunnel
pnpm lint:mobile:v2
pnpm typecheck:mobile:v2
pnpm test:mobile:v2
pnpm build:mobile:v2
```

Tunnel mode discovers the live Docker backend URL from the ngrok agent on local
port `4041`, verifies `/api/v1/health`, and injects that public origin into Expo.
App data therefore travels through the Docker/ngrok REST tunnel while Expo's
separate tunnel transports only the development JavaScript bundle. Start the
Docker remote-beta services before running `pnpm dev:mobile:v2:tunnel`.

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
