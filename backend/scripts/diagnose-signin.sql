-- Why a technician cannot sign in.
--
-- Sign-in answers "wrong email or password" for three different reasons, on
-- purpose (see session.service.ts:98-103): no credential, a bad password, and a
-- deactivated profile. This tells them apart.
--
-- Usage, on the VPS, with the address in question:
--   docker exec -i <postgres-container> psql -U postgres -d texasrenters \
--     -v email="'technician@texasrenters.com'" -f diagnose-signin.sql
--
-- Reads only. Nothing here writes.

\echo '== 1. Profiles for this address (>1 row means an orphan survived a delete) =='
SELECT id,
       "authUserId",
       email,
       "displayName",
       "isActive",          -- false here IS the "wrong email or password" message
       "createdAt"
FROM "UserProfile"
WHERE lower(email) = lower(:email);

\echo '== 2. Sign-in credential (absent = cannot sign in at all) =='
SELECT c."authUserId",
       c.email,
       c."mustChangePassword",
       c."lastSignInAt",     -- null = no successful sign-in has EVER happened
       c."createdAt",        -- compare with the profile above: a mismatch means
                             -- the credential belongs to an earlier generation
       left(c."passwordHash", 7) AS hash_prefix   -- $2a$/$2b$ only, never the hash
FROM "AuthCredential" c
WHERE lower(c.email) = lower(:email);

\echo '== 3. Does the credential point at a profile that exists? =='
-- An orphaned credential authenticates and is then refused a step later.
SELECT c."authUserId" AS credential_auth_user,
       p.id           AS profile_id,
       p."isActive",
       CASE WHEN p.id IS NULL THEN 'ORPHANED CREDENTIAL' ELSE 'linked' END AS state
FROM "AuthCredential" c
LEFT JOIN "UserProfile" p ON p."authUserId" = c."authUserId"
WHERE lower(c.email) = lower(:email);

\echo '== 4. Technician membership (no INSPECTION_TECHNICIAN row = the app refuses them after sign-in) =='
SELECT m."organizationId", m.role, o.name AS organization
FROM "OrganizationMember" m
JOIN "UserProfile" p ON p.id = m."userProfileId"
LEFT JOIN "Organization" o ON o.id = m."organizationId"
WHERE lower(p.email) = lower(:email);

\echo '== 5. What was done to this account, most recent first =='
SELECT "createdAt", action, "entityId", metadata
FROM "AuditLog"
WHERE metadata::text ILIKE '%' || trim(both '''' from :'email') || '%'
   OR "entityId" IN (SELECT id::text FROM "UserProfile" WHERE lower(email) = lower(:email))
ORDER BY "createdAt" DESC
LIMIT 20;
