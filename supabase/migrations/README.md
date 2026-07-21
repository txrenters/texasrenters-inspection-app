# Canonical Supabase migrations

Hand-written production migrations live here and use UTC timestamps in `YYYYMMDDHHMM_description.sql` order. Apply locally with `supabase db reset` or `supabase migration up`; review the generated plan before any linked-project `supabase db push`.

Prisma remains the backend ORM and `backend/prisma/schema.prisma` must describe the same schema. Prisma's existing migration records the original foundation; new integration changes are owned by this folder and must not be duplicated as conflicting Prisma migrations.

Migrations are forward-only in production. Rollback means a separately reviewed compensating migration, never editing an applied file. Back up production, test against a staging copy, verify RLS and service-role access, and never run migrations automatically from application startup.
