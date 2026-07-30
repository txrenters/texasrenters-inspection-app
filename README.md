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

The default opens Expo over LAN on the fixed Metro port `8081` for a fast Expo Go launch. A custom development client can be started with:

Normal LAN mode preserves Metro's cache. Use the explicit commands below when troubleshooting:

```bash
pnpm dev:mobile:lan       # explicit LAN mode
pnpm dev:mobile:clear     # LAN mode with a one-time Metro cache clear
pnpm dev:mobile:tunnel    # slower fallback when LAN routing is unavailable
```

The launcher always uses `mobile/` as the Expo project root and reports its selected private-LAN candidate. It never commits a developer-specific address.

```bash
pnpm --filter @texasrenters/mobile dev:client
```

If port `8081` is already occupied, stop the existing Metro process instead of allowing a second server to use another port.

On Windows, Metro requires a Private-network inbound firewall allowance. From an **Administrator PowerShell**, create the narrow Node/TCP/8081 rule with:

```bash
pnpm windows:mobile:lan:firewall
```

The helper affects only Private networks, the resolved `node.exe`, and TCP port `8081`. Remove it with `pnpm windows:mobile:lan:firewall:remove`. Never disable Windows Firewall globally.

The mobile launcher derives the active private LAN API address at startup. In tunnel mode, safe
read requests use the HTTPS Metro proxy first and automatically retry through that LAN address if
the proxy temporarily returns a gateway error. Start the backend before Expo and restart Expo when
the computer changes networks so the derived address stays current. Write requests are never
automatically replayed.

## Optional demo mode and roles

Set `EXPO_PUBLIC_ENABLE_DEMO_DATA=true` to expose the local Demo Login screen and choose one of these users:

| Demo user      | Role                   | Primary preview                        |
| -------------- | ---------------------- | -------------------------------------- |
| Maya Rodriguez | Inspection Technician  | Dashboard and room inspection workflow |
| Jordan Lee     | Condition Reviewer     | Findings and review decisions          |
| Alex Morgan    | Property Administrator | Property and approved-room context     |

A subtle Demo Mode banner remains visible. Settings shows `Data source: Mock repositories` and `Backend status: Not required`.

Important demo state persists locally through Zustand using SecureStore on native platforms. To restore the initial dataset, open **Settings → Reset demo data** and confirm. This clears the selected user, room changes, notes, local media, uploads, failures, and finding decisions.

## Repository switching

The mobile configuration is intentionally non-throwing:

```text
EXPO_PUBLIC_ENABLE_DEMO_DATA=true → mock repositories
unset or any other value          → authenticated REST repositories
```

`EXPO_PUBLIC_API_BASE_URL` identifies the shared backend origin, such as `http://localhost:3000`. API adapters do not silently fall back to mock data. Repository interfaces live in `mobile/src/repositories/contracts.ts`.

Property, owner, and portfolio records remain mastered by the company’s existing external application. A future backend integration layer will normalize its contracts and store external IDs alongside inspection-specific records. The mobile app will continue to call only the TexasRenters REST boundary.

## Simulated behavior

- Four properties and five inspections: two completed, two in progress, and one scheduled
- Oak Ridge House with two floors, eleven approved rooms, baselines, existing defects, and evidence placeholders
- One room-specific media record per recording review
- Upload transfer progress and retained failure/retry states
- Offline uploads remain pending while properties, inspections, and recording stay available
- Video processing, transcription, room analysis, baseline comparison, findings preparation, and ready-for-review stages
- Bedroom 1 findings for wall scratches, carpet stain, and closet hinge evidence
- Human review changes persist locally; no action approves charges or legal responsibility

## Optional backend development

The shared backend remains independently available:

```bash
pnpm dev:backend
```

- API: `http://localhost:3000/api/v1`
- Health: `http://localhost:3000/api/v1/health`
- Swagger: `http://localhost:3000/api/docs`

The backend connects to the managed Supabase PostgreSQL project through Prisma. Local PostgreSQL and Docker are not part of the application setup. Copy the project-specific transaction-pooler `DATABASE_URL` and session-pooler `DIRECT_URL` from **Supabase Dashboard > Connect > ORM > Prisma** into `backend/.env.local`.

### Propertyware synchronization

The backend now includes a read-only Propertyware v1 integration for portfolios, owner summaries, buildings, units, and move-out-relevant leases. Mock fixture mode and an in-memory store remain the safe local defaults; mobile clients receive normalized data only through `/api/v1`.

```bash
pnpm --filter @texasrenters/backend propertyware:sync:mock
pnpm --filter @texasrenters/backend propertyware:reconcile:mock
pnpm --filter @texasrenters/backend propertyware:status
```

Live mode requires all backend-only credentials documented in [PROPERTYWARE_OPERATIONS.md](docs/integrations/PROPERTYWARE_OPERATIONS.md). Apply the canonical Supabase migration in `supabase/migrations` before selecting `PROPERTYWARE_STORE=prisma`. No Propertyware write operation is implemented.

## Administrator web application

The Next.js administrator application lives in `web-app/`. It uses Supabase authentication, verifies an active admin organization membership through the shared backend, and accesses operational data only through `/api/v1/admin`.

```bash
Copy-Item web-app/.env.example web-app/.env.local
pnpm dev:backend
pnpm dev:web
```

The admin app runs at `http://localhost:5454`. Apply the Prisma foundation migration to the configured Supabase project first, then the Supabase migrations through `202607180005_add_admin_inspection_assignment_schema.sql` before scheduling or assigning inspections. See [ADMIN_WEB_RUNBOOK.md](docs/operations/ADMIN_WEB_RUNBOOK.md) for setup and troubleshooting.

## Quality commands

```bash
pnpm lint
pnpm typecheck
pnpm test
pnpm build
pnpm test:mobile
pnpm build:mobile
pnpm test:web
pnpm build:web
```

The frontend build is an Expo web export. Native binary builds require platform toolchains or EAS.

## Known limitations

- Recording and playback are polished simulations by default; live camera integration is not the primary demo path.
- Floor-plan geometry, OCR, and automated extraction are placeholders; approved room tags drive navigation.
- Upload and processing advance while their status screens are active; production background upload is deferred.
- API repository classes are explicit skeletons pending final REST and external-property contract alignment.
- SecureStore-backed Zustand persistence is suitable for demo metadata, not production video bytes or large evidence payloads.
- Role-specific route authorization, final reports, tenant charge calculation, and financial approval remain outside this frontend ticket.

## Proposal and next ticket

The unchanged source PDF remains at `docs/Mobile Move-Out Inspection System Proposal (1).pdf`; its canonical copy is `docs/product/MVP_PROPOSAL.pdf`.

Next recommended UI ticket: **TRI-UI-002 — Add real-device camera capture behind the MediaRepository, including permission-denied recovery and recording-review playback, while preserving the current mock simulator and one-video-per-room rule.**
