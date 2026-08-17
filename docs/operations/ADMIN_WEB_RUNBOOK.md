# Admin Web Runbook

## Local setup

1. Install Node.js 22.13+ (npm ships with it).
2. Run `npm ci`.
3. Configure `backend/.env.local` with the managed Supabase project. Copy the transaction-pooler `DATABASE_URL` and session-pooler `DIRECT_URL` from **Supabase Dashboard > Connect > ORM > Prisma**; do not point either URL at localhost.
4. Apply `backend/prisma/migrations/20260717000100_initial_foundation/migration.sql` to that Supabase project first, then the canonical files in `supabase/migrations` in timestamp order through `202607180005_add_admin_inspection_assignment_schema.sql`. Local PostgreSQL and Docker are not used.
5. Copy `web-app/.env.example` to `web-app/.env.local` and set the public Supabase URL, anon key, and shared backend base URL.
6. Run `npm run dev:backend`, then `npm run dev:web`.

To provision or reset the development Supabase super-admin, set
`SEED_SUPER_ADMIN_PASSWORD` in `backend/.env.local` and run
`npm run db:seed:super-admin`. The backend-only command uses the configured Supabase
service role to create or update the Auth user, confirms its email, activates its
application profile, and grants `SYSTEM_ADMIN` in the development organization.
Reruns preserve an existing password unless `SEED_SUPER_ADMIN_RESET_PASSWORD=true`.
The seeded Auth identity is marked as requiring a password replacement before
administrator APIs can be used. It refuses to run when `NODE_ENV=production`.

Admin web: `http://localhost:5454`  
REST API: `http://localhost:3000/api/v1`  
Swagger: `http://localhost:3000/api/docs`

## Release verification

Run `npm run lint`, `npm run typecheck`, `npm test`, and `npm run build`. Verify an active admin can sign in, an inspection can be created from active Propertyware records, assignment history survives reassignment, a technician with active work cannot be deactivated, and credentials are absent from browser responses/logs.

## Common failures

- `relation "Inspection" does not exist`: apply the foundation schema before the admin migration. Do not run the additive migration against an empty database.
- `relation "public.UserProfile" does not exist`: the same foundation migration is missing or was applied to a different schema/project.
- Prisma reports `localhost:5432`: replace stale local `DATABASE_URL` and `DIRECT_URL` values with the Supabase pooler URLs from the Connect dialog.
- Super-admin seed reports `foundation schema is missing`: apply the foundation migration and canonical Supabase migrations to the same project configured by `SUPABASE_URL`, then rerun the idempotent seed.
- Admin loops to login: verify the Supabase session, active `UserProfile`, organization membership, admin role, API URL, CORS origin, and JWT issuer configuration.
- Propertyware page returns 403: sync operations are restricted to system/property admins; inspection supervisors cannot operate the integration.
- Deactivation returns 409: reassign or unassign all current work first.
- Prisma generation fails with Windows `EPERM`: stop processes using the Prisma query engine, then rerun `npm run db:generate`.
- Web startup detects an occupied port: if TexasRenters is already running, the launcher reports its URL and exits successfully. If another application owns the port, stop it or set `WEB_APP_PORT` to a free port.
