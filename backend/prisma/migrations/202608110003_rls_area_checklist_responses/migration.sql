-- Tenant isolation for InspectionAreaChecklistResponse.
--
-- Matches what scripts/generate-rls-policies.mjs emits for a table carrying its
-- own organizationId — the same shape as "AreaChecklistItem" in
-- 202608080002_tenant_isolation_fail_closed. Added here because the generator
-- reads the live foreign-key graph, so it can only see this table after the
-- CREATE TABLE migration has run; regenerating afterwards reproduces exactly
-- this policy.
--
-- FAILS CLOSED, like every other policy in that migration: an unset
-- app.organization_id matches nothing rather than everything, so a missed
-- application-level filter returns no rows instead of another tenant's
-- assessments. '*' stays the explicit system escape hatch.
alter table "InspectionAreaChecklistResponse" enable row level security;
drop policy if exists tenant_isolation on "InspectionAreaChecklistResponse";
create policy tenant_isolation on "InspectionAreaChecklistResponse"
  using (
        current_setting('app.organization_id', true) = '*'
        or "organizationId"::text = current_setting('app.organization_id', true)
  )
  with check (
        current_setting('app.organization_id', true) = '*'
        or "organizationId"::text = current_setting('app.organization_id', true)
  );
