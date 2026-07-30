# Repository Structure

```text
mobile/  Expo technician application
web-app/     Next.js administrator application
backend/     Shared NestJS REST API and provider integrations
supabase/    Canonical PostgreSQL migrations
shared/      Framework-independent contracts, schemas, enums, and REST URL utilities
```

Both clients authenticate through Supabase Auth, obtain a user access token, and send it to the same NestJS backend. The mobile client uses `EXPO_PUBLIC_API_BASE_URL`; the web client uses `NEXT_PUBLIC_API_BASE_URL`. Both variables identify the shared backend origin and both clients call versioned `/api/v1` endpoints.

Propertyware synchronization, inspection and assignment transactions, authorization, audit logging, database access, transcription, AI analysis, Cloudflare integration, and provider readiness are backend responsibilities. Neither client imports backend implementation files, consumes raw Propertyware payloads, performs privileged Supabase operations, or contains a second domain server.

Supabase service-role keys, database URLs, and provider credentials belong only in backend environment configuration. The client templates contain public Supabase project values and the shared backend URL only.
