# ADR-001: Frontend/Backend Separation

Status: accepted. The active technician Expo client in `mobile/` and administrator
Next.js client in `web-app/` use the same versioned REST API in `backend/`. The legacy
`mobile/` remains in the workspace for reference but is not the default beta client.
Privileged Supabase access, Propertyware, provider credentials, business rules, and
authorization remain in NestJS. Each client is independently buildable without creating a
second backend.
