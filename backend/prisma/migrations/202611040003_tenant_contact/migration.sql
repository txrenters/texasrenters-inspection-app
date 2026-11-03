-- The tenant's name, phones and email, from the tenant report.
--
-- The office (2026-11-04): a benefit-package visit has to carry the tenant's
-- contact, the key information and the management plan, so the technician has
-- them at the door. Propertyware's REST API refuses leases and has no tenants
-- endpoint, so the contact comes from the report's Primary Contact columns.
--
-- Additive: three columns on a table whose tenant policy already covers them.
-- They fill on the next nightly tenant sync.

-- AlterTable
ALTER TABLE "PropertywareTenant"
  ADD COLUMN IF NOT EXISTS "contactName" TEXT,
  ADD COLUMN IF NOT EXISTS "contactPhones" TEXT[] NOT NULL DEFAULT ARRAY[]::TEXT[],
  ADD COLUMN IF NOT EXISTS "contactEmail" TEXT;
