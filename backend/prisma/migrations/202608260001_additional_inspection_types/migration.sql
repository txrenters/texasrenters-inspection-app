-- Four kinds of off-cycle visit the office asked for: a roof inspection, the
-- two Supra lockbox visits, and an air-conditioner filter delivery.
--
-- Postgres will not let a new enum value be used in the same transaction that
-- adds it, so each is its own statement and nothing here references them.
-- `IF NOT EXISTS` keeps the migration safe to re-run against a database that
-- was patched by hand before this landed.
ALTER TYPE "InspectionType" ADD VALUE IF NOT EXISTS 'ROOF';
ALTER TYPE "InspectionType" ADD VALUE IF NOT EXISTS 'SUPRA_LOCKBOX_PLACEMENT';
ALTER TYPE "InspectionType" ADD VALUE IF NOT EXISTS 'SUPRA_LOCKBOX_REMOVAL';
ALTER TYPE "InspectionType" ADD VALUE IF NOT EXISTS 'AC_FILTER_DELIVERY';
