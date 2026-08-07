# Migrating off Supabase

Moving the database to a dockerized PostgreSQL, replacing Supabase Auth with
self-hosted auth, and adding Row Level Security as a second wall behind the
existing application-level tenancy filters. Target deployment is a VPS.

Decisions taken 2026-08-07: **database and auth both move**; **RLS is
defense-in-depth** and every existing `organizationId` filter stays exactly as
it is; **a brief planned downtime** at cutover is acceptable.

---

## What we are actually migrating

Supabase is doing three unrelated jobs here, and they separate cleanly.

| Job | Where it lives | Difficulty |
| --- | --- | --- |
| Postgres database | `DATABASE_URL` | Small — see Phase 1 |
| Auth (identity, sessions, passwords) | Backend guards + both clients | The real work — Phase 2 |
| Object storage | `object-storage.ts` | Already migrated to R2; only dead config remains |

---

## Findings that change the plan

These came out of a survey of the backend, both clients, and the live database.
Each one either shrinks the work or is a trap worth knowing about early.

### 1. RLS would be inert today (highest-value finding)

The application connects as `postgres`, which **owns every table** and has
**`rolbypassrls = true`**. Policies attached under that role do nothing at all,
and they fail *silently* — the queries keep working, and it looks like RLS is
protecting you.

The live database also has **zero policies and zero RLS-enabled tables** right
now. `supabase/migrations/202607180001` and `...0003` do enable RLS, but that
directory is a historical trail from the old hosted instance; the current
database was rebuilt from `backend/prisma/migrations/20260717000000_baseline_full_schema`
and none of it survived. Do not port those policies forward — they call
`auth.uid()`, which will not exist on a plain Postgres image.

So Phase 3 must begin by creating a dedicated, non-owning, non-`BYPASSRLS`
application role. Everything else in that phase is worthless without it.

### 2. Self-hosted auth is much less work than it looks

`backend/src/common/auth.ts` **already verifies HS256 tokens locally**, with no
network call, using `SUPABASE_JWT_SECRET`. The asymmetric path that calls
Supabase only runs for ES256/RS256 tokens. If we mint our own HS256 tokens, the
existing verification path works essentially unchanged.

Two hardcoded strings are the only blockers:

- issuer must equal `${SUPABASE_URL}/auth/v1` — `auth.ts:207`, `:261`
- audience must contain the literal `'authenticated'` — `auth.ts:209`, `:263`

Both become configuration in Phase 0.

`UserProfile.authUserId` is a plain **unique TEXT column, not a foreign key** —
Prisma cannot reference the `auth` schema. So a new identity system needs **no
schema change** to the link column, whatever subject format it uses.

### 3. Email is already ours

`generateLink` mints a recovery token but **sends nothing**. Every email in this
system already goes out through Microsoft Graph (`backend/src/mail/`). The only
Supabase-owned artifact in the reset flow is the token itself.

The team also already abandoned Supabase's own reset flow — see the comment in
`web-app/app/forgot-password/page.tsx:19-23`. The backend mints the link and the
web app redeems it with `verifyOtp`. Only that redemption step needs replacing.

### 4. The data is tiny

**4 MB total.** Largest tables are `propertyware_portfolios` (1113 rows) and
`propertyware_buildings` (562). The entire inspection domain is empty after the
2026-08-06 reset. Dump and restore take seconds, so cutover downtime is bounded
by verification, not by data volume.

### 5. The database swap itself needs no code change

`backend/src/database/database-connection.ts:17` already returns
`category: 'direct'` and leaves the URL untouched for any non-Supabase host. The
pooler rewrites only apply to `*.pooler.supabase.com`. Pointing `DATABASE_URL`
at a dockerized Postgres takes the direct branch automatically.

All 6 Prisma migrations are portable SQL — no `CREATE EXTENSION`, no `auth.` or
`storage.` schema references.

### 6. Five places genuinely have no organization

Naive `organizationId = current_setting(...)` policies break all of these. They
need explicit handling in Phase 3, not discovery in production:

1. **Boot-time cross-org sweeps** — `propertyware-sync.coordinator.ts` reclaims
   stale runs across every tenant; `media-processing.service.ts` re-queues
   interrupted work the same way.
2. **The Cloudflare Stream webhook** — looks up media by `streamUid`. There is
   no identity in the request to derive an organization from.
3. **Homeowner report links** — `GET /reports/:token` has no guard at all; the
   token *is* the credential. `InspectionReportShare` does carry
   `organizationId`, so the fix is to resolve the share first and set the GUC
   from it.
4. **Password reset lookup** — an unauthenticated global lookup by email.
5. **The auth query itself** — the query that resolves the organization cannot
   be organization-scoped. Same for the WebSocket handshake.

### 7. Three invariants are documented as enforced but do not exist

Worth fixing while Phase 3 is already touching every table:

- the one-`PRIMARY_AREA`-video-per-area partial unique index
  (`schema.prisma:1163` claims it exists — it does not)
- `NULLS NOT DISTINCT` on the `PropertyFloor` and `PropertyArea` name indexes
  (`:516`, `:570`), without which building-level rows can duplicate
- the marker/bbox `0..1` CHECK constraints

Also: 15 of the 25 tables with a direct `organizationId` have **no foreign key**
on it. An RLS `WITH CHECK` would be the first enforcement those columns have
ever had.

---

## Phases

Each phase is independently valuable, independently reversible, and leaves the
system working. Do not start the next one until the previous is verified.

### Phase 0 — Seams (no behaviour change)

Make the things that are hardcoded configurable, so later phases are
configuration rather than surgery. Nothing observable changes.

- `AUTH_JWT_ISSUER` and `AUTH_JWT_AUDIENCE` config, defaulting to the current
  Supabase values so existing tokens keep verifying
- an `IdentityProvider` interface over the four `SupabaseAdminGateway` methods
  (`createTechnicianIdentity`, `createWebUserIdentity`, `deleteIdentity`,
  `identityExists`), with the Supabase implementation behind it
- `SUPABASE_SERVICE_ROLE_KEY` added to the env schema — password reset and
  provisioning both require it today but nothing validates it at boot

The existing tests stub the gateway **structurally**, so preserving those four
signatures keeps `admin-operations.spec.ts`, `profile-deletion.spec.ts` and
`access.spec.ts` passing untouched.

### Phase 1 — Database to dockerized Postgres

Supabase Auth stays; only `DATABASE_URL` moves. Fully reversible by pointing the
URL back.

**Done:**

1. ✅ Postgres promoted out of the `local-db` profile to a first-class service.
2. ✅ `backend/scripts/migrate-to-local-postgres.mjs` — copies `public` and
   verifies the result. `pnpm db:migrate-to-local[ --confirm | --verify]`.
3. ✅ Copy run and verified: **53 tables, 1797 rows, 138 indexes, 90 unique
   indexes, 79 foreign keys**, all matching the source.

4. ✅ **Cut over, 2026-08-07.** `DATABASE_URL` and `DIRECT_URL` in
   `backend/.env.local` now name the container; the Supabase values are kept
   directly above them, commented, so rolling back is uncommenting two lines.
   The backend reports `connection.category: "direct"` and answers
   `/health/database` in **1.3 ms** — against roughly 380 ms through the
   Supabase pooler.

5. **Still to do: change the `postgres:postgres` password** before this is
   anything but local.

**A trap this cutover found.** `pg_dump --clean` emits `DROP SCHEMA public`, and
both the table `GRANT`s and the `pg_default_acl` rows are keyed on that
namespace — so a copy silently leaves `texasrenters_app` able to read nothing,
and `ALTER DEFAULT PRIVILEGES` does not survive either. **Re-run
`pnpm db:setup-app-role --confirm` after every copy.** The migration script now
says so on completion.

**The stack is deliberately mixed right now: new database, old code.** The
running images predate Phase 2, so they still verify Supabase tokens — which
works, because the `UserProfile` rows were copied with identical `authUserId`
values, so a Supabase token resolves the same person out of the local database.
That state is coherent and was worth keeping while the database move settles.

Rebuilding (`pnpm docker:up`) deploys Phase 2 as well, at which point sign-in
moves to `/auth/login` and **everyone signs in again once**.

Implementation notes worth keeping:

- `pg_dump` and `psql` run **inside the container**, so no host Postgres install
  is needed and the client version cannot drift from the server.
- The source is `DIRECT_URL`, not `DATABASE_URL`. The latter is the transaction
  pooler on 6543, where `pg_dump` cannot hold a consistent snapshot — and
  `?pgbouncer=true` is Prisma-only, which `psql` rejects outright.
- Only `public` is copied. `auth`, `storage`, `realtime`, `vault` and `graphql`
  are Supabase's own. `auth.users` is Phase 2's problem and wants its password
  hashes migrated rather than the schema dumped wholesale.
- `--no-owner --no-privileges`: Supabase's grants reference `anon`,
  `authenticated` and `service_role`, none of which exist on a plain image.

### Phase 2 — Self-hosted auth

The large phase. Ordered so the backend can serve both old and new tokens during
the transition.

1. ✅ **Password store.** `AuthCredential` + `AuthRefreshToken`. 3 accounts
   imported from `auth.users`, hashes verified byte for byte. `authUserId`
   preserved, so both systems resolve the same person.
   `pnpm db:import-credentials`.
2. ✅ **Token issuing.** `TokenService` mints HS256 through the Phase 0 seam.
   Hand-rolled on `node:crypto` rather than adding a JWT library, because
   `verifySupabaseJwt` already implements this exact algorithm and two
   implementations would drift. A round-trip test pins mint → verify: if they
   ever disagree, every sign-in succeeds and the next request 401s.
3. ✅ **Backend endpoints.** `POST /auth/login`, `/auth/refresh`, `/auth/logout`.
   Refresh rotates; a retired token presented again is a replay and ends every
   session for that account.
4. ✅ **Replace the identity provider.** `LocalIdentityProvider` implements the
   Phase 0 interface; `AUTH_IDENTITY_PROVIDER=local` selects it, defaulting to
   `supabase` so it ships inert and flips back the same way.

   It creates the `UserProfile` alongside the credential, which looks like a
   layering violation and is a faithful port: Supabase ran a `SECURITY DEFINER`
   trigger (`handle_texasrenters_auth_user`) that inserted a profile on every
   `auth.users` insert. That is *why* both provisioning services already contain
   "claim the triggered profile" logic — so this keeps that path live and no
   caller changed. It is also what the foreign key requires, and both rows are
   written in one transaction.

   Verified end to end against the real Postgres, not only mocks: provision →
   sign in → wrong password → refresh → replay → password change → cascade
   cleanup, 13/13.

Verified against the real imported rows: all three are `$2a$` cost 10, and
bcryptjs parses them. bcryptjs emits `$2b$`, which differs from `$2a$` only in a
wraparound fix for passwords ≥ 256 bytes — irrelevant here, and `$2a$` verifies.

Deliberate choices worth keeping:

- **bcrypt for passwords, SHA-256 for refresh tokens.** Opposite answers to
  opposite problems: a password is low-entropy and human-chosen, which is what
  a work factor defends; a refresh token is 256 bits of CSPRNG output with no
  dictionary to attack, and refresh runs on every expired access token where a
  slow hash would be felt.
- **Refresh tokens stored hashed.** The table is a list of live sessions;
  plaintext there would be as good as a password for every signed-in user.
- **One 401 for every sign-in failure** — unknown address, wrong password,
  deactivated profile. The active check happens *after* the hash comparison,
  and a miss compares against a real throwaway hash, so neither the message nor
  the timing identifies an account.
- **`must_change_password` is minted from the column** into the claim the
  guards already read. The column becomes authoritative while nothing that
  reads the claim has to change.
5. ✅ **Recovery tokens.** `AuthPasswordResetToken` + `PasswordResetService`,
   with a new `POST /auth/reset-password`. Routed by the same
   `AUTH_IDENTITY_PROVIDER` switch, so it still delegates to Supabase today.

   Deliberately does **less** than what it replaces. Supabase's token was
   redeemed with `verifyOtp` for a full **session**, so anyone holding the email
   was signed in and then merely expected to change the password. Ours buys a
   password change and nothing else — a link sent in the clear is not a login.
   Single use, one hour, stored as SHA-256, and requesting another retires the
   outstanding one so asking twice does not leave two live credentials in two
   mailboxes.

   Verified end to end against the real Postgres: 10/10, including that the old
   password stops working and every prior session dies.
6. ✅ **Clients.** Both are off Supabase; the packages are removed from all
   three `package.json` files and every `*_SUPABASE_*` variable is gone.

   **This is the point the migration stops being inert.** `SessionService`
   authenticates against `AuthCredential` regardless of
   `AUTH_IDENTITY_PROVIDER`, so once a client posts to `/auth/login` it is using
   self-hosted auth. Rollback is reverting those two commits.

   **Devices already signed in must sign in once more.** A Supabase refresh
   token cannot be exchanged for one of ours, so no live session carries across.
   The app is unreleased, so this costs the test handsets one sign-in.

   Original notes on the two hard parts, and how each was handled:
   - **Web** stores the session in **cookies** (`@supabase/ssr` hardcodes this),
     and `middleware.ts` reads those cookies server-side. Two independent
     consumers of one credential. A localStorage-only replacement silently
     disables server-side route protection — and `middleware.ts:11` already
     fails open when unconfigured.
   - **Mobile** stores the session in **expo-secure-store, chunked** across
     `<key>.<n>` entries because SecureStore caps near 2 KB. Devices in the
     field hold live refresh tokens in that format.
   - Both clients call `getSession()` on **every request** and rely on auth-js
     refreshing transparently inside it. Nothing anywhere calls
     `refreshSession()`. A replacement whose "get token" is a pure read will
     start emitting expired tokens under exactly the conditions today's code
     survives.
7. **Pick one source of truth for `mustChangePassword`.** Web reads it from the
   JWT claim; mobile reads it from `/auth/me`. They disagree today.

**Mobile trap:** the Supabase user id is the partition key for both on-device
caches. `offline-record-cache.ts` *throws* without a session, so a failed
session restore means **no cached data at all**, not stale data. And
`clearQueryCache()` no-ops without a session, which is why `useSignOut` must
clear before signing out — get that ordering wrong and one technician's
assignments persist for the next on a shared device.

### Phase 3 — RLS as defense-in-depth

Every application-level `organizationId` filter stays. A missed filter should
become a returned-nothing bug, never a cross-tenant leak.

1. ✅ **Dedicated application role.** `pnpm db:setup-app-role`, idempotent,
   creates `texasrenters_app`: `NOSUPERUSER`, `NOBYPASSRLS`, owns nothing, DML
   on every table and no DDL — so it cannot drop a policy that constrains it.
   `ALTER DEFAULT PRIVILEGES` covers tables added later, or the next migration
   produces a table the app silently cannot read.

   Two connections, which is what Prisma's `directUrl` already exists for:
   `DATABASE_URL` → this role, subject to policies; `DIRECT_URL` → the owner,
   migrations only.

   **Demonstrated rather than assumed.** With a deny-all policy on
   `Organization`: the app role read **0** rows while the owner read **1**.

   **Correction to an earlier assumption in this document:** `FORCE ROW LEVEL
   SECURITY` does *not* make the current owner subject to policies, because
   `postgres` is a **superuser** and superuser bypass is absolute — measured, the
   owner still read 1 row after `FORCE`. That is fine and expected; migrations
   need it. What protects the data is that the *runtime* connection is a role
   which cannot bypass anything. Do not rely on `FORCE` as the safeguard.
2. **Set the tenant GUC per request.** With transaction-mode pooling a
   session-level `SET` leaks across tenants, so it must be `SET LOCAL` inside a
   transaction. We control the pooling now, so decide session vs transaction
   pooling *before* writing policies — it determines whether every single
   statement has to become a `$transaction`.
3. **Policies**, in three shapes: 25 models with a direct `organizationId`, 22
   reachable transitively (deepest is `BaselineMedia`, 3 hops), and 5 genuinely
   global (`Organization`, `UserProfile`, `WebhookEvent`,
   `PropertywareSyncLock`, `_prisma_migrations`).
4. **Handle the five org-less paths** from finding 6 explicitly.
5. **Test the 22 `relationLoadStrategy: 'join'` sites.** With join strategy
   Prisma emits one `LATERAL` query and every nested relation's policy is
   evaluated inside it — a missing policy empties the nested array rather than
   erroring, so it presents as a data bug, not a permissions bug.

**Open design question, deliberately not pre-decided:** the RLS predicate can be
single-valued (parity with today's `memberships[0]`) or set-valued (correct for
multi-org users, but then *wider* than the app's own filter, which stops it
being a strict second wall). Today there is 1 organization and no user belongs to
more than one, so this is not yet urgent — but `memberships[0]` has no
`orderBy`, so a multi-org user's effective organization is currently whatever
order Postgres returns. That should be fixed in app code regardless.

**Not covered by RLS:** the Redis response cache is keyed by
`user.organizationId` outside Postgres. A missed filter that RLS catches in the
database could still be served from a mis-scoped cache entry.

---

## Rollback

- **Phase 1** — point `DATABASE_URL` back at Supabase. Keep the Supabase project
  alive and untouched until Phase 2 is verified in production.
- **Phase 2** — keep Supabase Auth able to verify for one release. Because
  `authUserId` values are preserved, both systems resolve the same profiles.
- **Phase 3** — policies can be dropped without touching application code, since
  every application-level filter remains in place throughout.

## Decommissioning

Only after all three phases are verified: remove `@supabase/supabase-js` and
`@supabase/ssr` from all three packages, delete the `supabase` branch of
`object-storage.ts`, delete `supabase/migrations/` (historical), and revoke the
Supabase keys. `mobile/src/config/environment.ts` exports `supabaseUrl` with
zero consumers — that one can go at any time.
