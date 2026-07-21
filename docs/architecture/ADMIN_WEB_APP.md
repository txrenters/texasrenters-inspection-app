# Administrator Web Application

## Boundary

`web-app/` is the root-level, desktop-first Next.js administrator application. Supabase Auth supplies an access token; the browser sends that token to the shared NestJS REST API in `backend/`. The browser never receives database credentials, the Supabase service-role key, or external-provider secrets.

```text
Browser (Next.js) -> Bearer token -> NestJS /api/v1/admin -> Prisma -> PostgreSQL
                                      |
                                      +-> read-only Propertyware sync coordinator
```

The backend derives the organization from the authenticated membership and scopes every admin query to that organization. Client-supplied organization IDs are not accepted by admin DTOs.

## Modules

- Authentication: session restoration, secure sign-in, password reset, backend profile verification, and admin route guard.
- Catalog: active Propertyware portfolios, properties, units, and relevant leases.
- Operations: inspection scheduling, server-side filtering, assignment history, technician workload, and audit activity.
- Integrations: Propertyware sync controls/runs and redacted provider-readiness status.
- Shared contracts: `shared/src/contracts/admin.ts` is the browser/backend response boundary.

TanStack Query owns server state, request cancellation, cache invalidation, and limited status polling. React Hook Form and Zod own client form validation; Nest DTO validation and service business rules remain authoritative.

## Failure states

Screens have loading, empty, and retryable error states. API 401 responses clear the Supabase session. Network and configuration failures use sanitized messages and request IDs where available. Provider status exposes readiness only, never secret values.
