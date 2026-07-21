# Admin Authentication and Authorization

## Authentication flow

1. The browser signs in with Supabase email/password using the public anon key.
2. The admin API client reads the active Supabase access token and sends it as `Authorization: Bearer ...`.
3. `ApiAuthGuard` validates signature, issuer, audience, and expiry, then loads the active `UserProfile` and organization memberships.
4. `/api/v1/admin/profile` confirms the profile is active and returns only safe identity/membership data.
5. The frontend admits `SYSTEM_ADMIN`, `PROPERTY_ADMIN`, and `INSPECTION_SUPERVISOR`. Backend `RolesGuard` remains authoritative.

There is no public administrator signup. Password reset uses Supabase recovery links and returns to `/reset-password`.

System and property administrators provision technician accounts through `POST /api/v1/admin/technicians`. The backend generates the temporary password, creates a confirmed Supabase identity, records the organization-scoped technician membership, and returns the password exactly once. The password is never persisted in the application database, audit metadata, or browser storage. Supervisors can manage assignments and technician status but cannot create identities.

Development accounts may be seeded with a temporary password. Supabase app metadata
marks these identities with `must_change_password`. The web application routes them
to the required password-replacement screen, and backend role-protected endpoints
remain forbidden until the authenticated password-change endpoint replaces the
password and clears that server-controlled flag.

Technician identities use the same server-controlled flag. The mobile application permits only the required password-change flow until a replacement of at least 12 characters succeeds, then signs the session out so the technician must authenticate with the new password.

## Security notes

- Production must set `SUPABASE_URL` and the server-side JWT verification secret/key configuration.
- `USE_MOCK_AUTH` is forbidden in production by the guard.
- The Supabase service-role key is backend-only and must never use a `NEXT_PUBLIC_` prefix.
- Organization scope comes from the verified membership, not a query/body field.
- Disabled profiles and non-admin roles cannot use admin routes even if they possess a valid Supabase session.
