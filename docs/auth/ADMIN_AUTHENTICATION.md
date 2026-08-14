# Admin Authentication and Authorization

## Authentication flow

1. The browser signs in with Supabase email/password using the public anon key.
2. The admin API client reads the active Supabase access token and sends it as `Authorization: Bearer ...`.
3. `ApiAuthGuard` validates signature, issuer, audience, and expiry, then loads the active `UserProfile`, organization membership, and custom role assignments.
4. The backend resolves permissions for the selected organization. `SYSTEM_ADMIN` receives the protected bootstrap override; every other web user receives only permissions from administrator-created roles.
5. `/api/v1/admin/profile` confirms the profile is active and returns only safe identity, membership, and effective-permission data.
6. The frontend admits the protected system administrator or an active account with at least one effective permission. Backend `PermissionsGuard` remains authoritative on every custom-RBAC admin route.

There is no public administrator signup. Password reset uses Supabase recovery links and returns to `/reset-password`.

Web users are provisioned through `POST /api/v1/admin/access/users` by a principal
with `users:manage`. The backend creates a confirmed Supabase identity, records
the organization membership, assigns only the selected custom roles, and returns
the temporary password exactly once. Technician accounts remain a separate
mobile-only workflow through `POST /api/v1/admin/technicians` and require
`technicians:provision`.

Development accounts may be seeded with a temporary password. Supabase app metadata
marks these identities with `must_change_password`. The web application routes them
to the required password-replacement screen, and backend role-protected endpoints
remain forbidden until the authenticated password-change endpoint replaces the
password and clears that server-controlled flag.

Technician identities use the same server-controlled flag. The mobile application permits only the required password-change flow until a replacement of at least 12 characters succeeds, then signs the session out so the technician must authenticate with the new password.

## Security notes

- Production must set `SUPABASE_URL` and the server-side JWT verification secret/key configuration.
- `USE_MOCK_AUTH` no longer exists. The guard has no bypass branch: every request authenticates against a real token, in every environment.
- The Supabase service-role key is backend-only and must never use a `NEXT_PUBLIC_` prefix.
- Organization scope comes from the verified membership, not a query/body field.
- Disabled profiles and accounts with no effective web permission cannot use the admin console even if they possess a valid Supabase session.
- An administrator cannot change their own role assignments. A non-system administrator also cannot edit or delete a role assigned to their own account.
