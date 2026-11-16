-- A technician's pest control license number (2026-11-16). Crystal Creek
-- Pest's invoices name who did the work, with their Texas Department of
-- Agriculture license: "Serviced by: Clinton Bass (0557779) and Kevin Granados
-- (1006056)". Additive: one nullable column, kept short and free of spaces at
-- either end.

-- AlterTable
ALTER TABLE "UserProfile" ADD COLUMN     "pestLicenseNumber" VARCHAR(20);

ALTER TABLE "UserProfile" ADD CONSTRAINT "UserProfile_pest_license_trimmed" CHECK ("pestLicenseNumber" IS NULL OR ("pestLicenseNumber" = btrim("pestLicenseNumber") AND "pestLicenseNumber" <> ''));
