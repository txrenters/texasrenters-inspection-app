# TexasRenters Inspection Platform

Texas Renters Inspection contains a technician mobile application, an administrator web application, and one shared NestJS backend. Both clients authenticate with Supabase Auth and use the same versioned REST API. Propertyware, PostgreSQL, provider credentials, business rules, and privileged operations remain backend-only.

## Current MVP status

The mobile application is the current development priority. It includes:

- Supabase technician sign-in with a mandatory first-login password replacement
- Administrator-created technician accounts with one-time temporary passwords
- Technician dashboard, searchable inspection list, overview, floor plan, and approved room checklist
- Room baseline, documented defects, notes, skip reason, and completion state
- Camera-safe recording simulation, recording review, local media creation, and upload queueing
- Upload progress, pause/resume/retry/remove, offline simulation, and six-stage AI processing
- Grouped findings, finding detail, edit, approve confirmation, rejection reason, and reinspection reason
- Assignment-scoped live properties, inspections, rooms, findings, media, and upload status
- An explicit demo-only mode for isolated UI development and automated tests

Live authentication and Propertyware portfolio/building synchronization are connected. Cloud video upload, transcription, Anthropic processing, financial approval, and production reporting remain unconnected.

## Architecture

- `mobile/`: Expo SDK 54 technician application using Expo Router, TypeScript, TanStack Query, Zustand, SecureStore, and repository adapters.
- `web-app/`: Next.js administrator application for properties, inspections, assignments, technicians, and integration monitoring.
- `backend/`: the single NestJS REST API under `/api/v1`, shared by both clients.
- `supabase/`: canonical PostgreSQL migrations.
- `shared/`: framework-independent API contracts, schemas, and enums reused across application boundaries.
- `docs/`: product, architecture, security, and decisions. The source proposal PDF remains preserved.

Screens call feature hooks, which call repository interfaces. The repository container selects authenticated REST implementations by default; mock implementations require explicit demo configuration. The mobile app never accesses PostgreSQL, privileged credentials, or Propertyware directly.

## Install

Requirements: Node.js `22.13` or newer and pnpm `11.9.0`.

```bash
pnpm install --frozen-lockfile
```

No `.env`, backend, Docker service, API key, Supabase project, or provider credential is required for the explicit mobile demo mode.

## Start Expo

From the repository root:

```bash
pnpm dev:mobile
```

From `mobile/`:

```bash
pnpm start
```

Metro runs on port `8082` and is served through the Cloudflare Tunnel, not the
LAN. That is the only mode: the office network isolates clients, so LAN never
worked there, and every hostname is published through the tunnel now.

`pnpm start` reads `CLOUDFLARE_TUNNEL_HOSTNAME` and `CLOUDFLARE_METRO_HOSTNAME`
from `backend/.env.local` and hands both to Expo — the first as the API origin,
the second as `EXPO_PACKAGER_PROXY_URL`. Bring the stack up first with
`pnpm remote-beta`, which starts the backend and the tunnel and then runs the
same command.

To clear Metro's cache once:

```bash
pnpm dev:mobile:clear
```

If port `8082` is occupied, stop the existing Metro process rather than letting
a second server pick another port — the tunnel route names 8082 specifically.
