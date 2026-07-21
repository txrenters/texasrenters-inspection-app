# System Architecture

## Repository applications

The repository has two independent clients and one shared backend:

```text
Propertyware API
  -> backend/ (NestJS REST API, authorization, integration workers, Prisma)
      -> Supabase PostgreSQL
      -> mobile-app/ (Expo technician application)
      -> web-app/ (Next.js administrator application)
```

`mobile-app/` owns technician authentication, assigned inspections, room workflows, media capture, and upload/processing status. Production-style development uses the REST repositories by default; an explicit local demo repository remains available for isolated product demonstrations and tests:

```text
Expo Router screens
  → feature query/mutation hooks
  → repository interfaces
      → REST repositories (default)
      → mock repositories (explicit demo mode only)
  → Expo Camera capture and app-document video storage
  → Zustand persisted demo state
      → SecureStore adapter on native
      → browser storage adapter for Expo web validation
```

Configuration is safe at module import time. Missing environment variables do not throw, perform a health check, or contact a provider. `EXPO_PUBLIC_ENABLE_DEMO_DATA=true` is required to select mock adapters; no other value enables them.

The mobile domain includes external property, owner, portfolio, and inspection IDs without treating device state as the master record. Screens never import fixture JSON or mock implementations directly.

Room video capture is functional on native devices. The camera output is moved from temporary cache into app document storage before its metadata is persisted. Upload and downstream processing remain simulated; no recording is sent to a backend or third party.

`web-app/` owns administrator authentication, dashboard, synchronized property views, inspection scheduling, assignment history, technician management, and integration readiness. It uses Supabase Auth only for sessions and loads operational data from `/api/v1/admin` on the shared backend.

## Connected runtime boundary

Both clients communicate only with the versioned NestJS HTTPS REST API. NestJS validates Supabase access tokens and owns organization authorization, business rules, integration normalization, audit records, and signed media access. Neither client has PostgreSQL, Propertyware credential, service-role, or provider-secret access.

Prisma targets PostgreSQL. Redis/BullMQ, Cloudflare Stream, transcription, Anthropic, Supabase services, and external property APIs remain behind backend interfaces. Production targets remain Expo EAS and a non-root API image.

The two clients and backend are independently buildable. Mobile mock behavior is never a fallback after an API or authentication error. Next.js route handlers must not duplicate backend domain logic.
