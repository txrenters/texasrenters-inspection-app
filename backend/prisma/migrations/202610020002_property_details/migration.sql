-- The property as Propertyware describes it, and its owners.
--
-- The office keeps most of what it knows about a home in Propertyware: the
-- building record and some sixty custom fields filled in by hand (occupancy,
-- make ready, utilities, HVAC filters, the lockbox and gate codes). The
-- console showed none of it (2026-10-01). The sync now keeps a snapshot on the
-- building, and the property-owner report adds the owners and their phones.

-- AlterTable
ALTER TABLE "propertyware_buildings"
  ADD COLUMN IF NOT EXISTS "details" JSONB,
  ADD COLUMN IF NOT EXISTS "ownerDetails" JSONB;
