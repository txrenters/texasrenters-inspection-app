# Database migrations

Postgres is hosted on Supabase. Prisma is the backend client, so every schema
change is authored **twice**: as a Prisma migration (which the backend applies and
tracks) and as a canonical Supabase mirror.

```
backend/prisma/migrations/<YYYYMMDD><NNNN>_<name>/migration.sql
supabase/migrations/<YYYYMMDD><NN>_<name>.sql
```

The two directories keep independent counters. Both files must contain equivalent
DDL; the Supabase mirror is written idempotently (`IF NOT EXISTS`, `DO $$ …
EXCEPTION WHEN duplicate_object`) so it can be replayed safely.

## Applying a migration

`prisma migrate dev` is **not usable** on this project — shadow-database creation
fails against a historical migration. Apply migrations explicitly instead:

```bash
cd backend
# env lives in .env.local, not .env
set -a && . ./.env.local && set +a

npx prisma db execute --file prisma/migrations/<dir>/migration.sql --schema prisma/schema.prisma
npx prisma migrate resolve --applied <dir>
npx prisma generate
```

`prisma generate` fails with `EPERM … query_engine-windows.dll` on Windows while
the backend dev server holds the engine. Stop the running backend
(`nest start`/`dist/main`) first, then regenerate.

## Rules

- **Never edit an already-applied migration.** Add a new one.
- Prefer additive, nullable columns so existing rows stay valid; avoid destructive
  changes.
- Encode invariants in the database, not only in application code — e.g. the
  normalized marker range guards in
  `202607250006_area_spatial_markers` (`CHECK (markerX IS NULL OR (markerX >= 0
  AND markerX <= 1))`) and the partial unique index enforcing one primary video
  per area in `202607250002_additional_labeled_videos`.
- Keep `backend/prisma/schema.prisma` aligned with the SQL, then run
  `npx prisma format` and regenerate the client.
