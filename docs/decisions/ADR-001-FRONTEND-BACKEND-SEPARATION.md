# ADR-001: Frontend/Backend Separation

Status: accepted. The technician Expo client in `mobile-app/` and administrator Next.js client in `web-app/` use the same versioned REST API in `backend/`. Privileged Supabase access, Propertyware, provider credentials, business rules, and authorization remain in NestJS. Each client is independently buildable without creating a second backend.
