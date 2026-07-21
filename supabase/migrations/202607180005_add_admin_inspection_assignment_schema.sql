-- Forward-only admin inspection and append-only assignment history extension.
-- Requires the original Prisma foundation migration and Propertyware migration 001.

DO $$
BEGIN
  IF to_regclass('public."Inspection"') IS NULL
     OR to_regclass('public."InspectionAssignment"') IS NULL
     OR to_regclass('public."UserProfile"') IS NULL THEN
    RAISE EXCEPTION 'TexasRenters Prisma foundation migration 20260717000100_initial_foundation is required before admin migration 005';
  END IF;

  IF to_regclass('public.propertyware_buildings') IS NULL
     OR to_regclass('public.propertyware_units') IS NULL
     OR to_regclass('public.propertyware_leases') IS NULL THEN
    RAISE EXCEPTION 'Propertyware migration 202607180001_create_propertyware_sync_schema is required before admin migration 005';
  END IF;

  ALTER TABLE public."Inspection" ALTER COLUMN "propertyId" DROP NOT NULL;
  ALTER TABLE public."Inspection" ADD COLUMN IF NOT EXISTS "propertywareBuildingId" uuid;
  ALTER TABLE public."Inspection" ADD COLUMN IF NOT EXISTS "propertywareUnitId" uuid;
  ALTER TABLE public."Inspection" ADD COLUMN IF NOT EXISTS "propertywareLeaseId" uuid;
  ALTER TABLE public."Inspection" ADD COLUMN IF NOT EXISTS "inspectionType" text NOT NULL DEFAULT 'MOVE_OUT';
  ALTER TABLE public."Inspection" ADD COLUMN IF NOT EXISTS "priority" text NOT NULL DEFAULT 'STANDARD';
  ALTER TABLE public."Inspection" ADD COLUMN IF NOT EXISTS "internalNotes" text;
  ALTER TABLE public."Inspection" ADD COLUMN IF NOT EXISTS "createdById" uuid;
  ALTER TABLE public."Inspection" ADD COLUMN IF NOT EXISTS "cancelledAt" timestamptz;
  ALTER TABLE public."Inspection" ADD COLUMN IF NOT EXISTS "cancellationReason" text;
  ALTER TABLE public."Inspection" ADD COLUMN IF NOT EXISTS "leaseSnapshot" jsonb;

  ALTER TABLE public."InspectionAssignment" ADD COLUMN IF NOT EXISTS "assignedById" uuid;
  ALTER TABLE public."InspectionAssignment" ADD COLUMN IF NOT EXISTS "endedById" uuid;
  ALTER TABLE public."InspectionAssignment" ADD COLUMN IF NOT EXISTS "supersedesId" uuid;
  ALTER TABLE public."InspectionAssignment" ADD COLUMN IF NOT EXISTS "isCurrent" boolean NOT NULL DEFAULT true;
  ALTER TABLE public."InspectionAssignment" ADD COLUMN IF NOT EXISTS "endedAt" timestamptz;
  ALTER TABLE public."InspectionAssignment" ADD COLUMN IF NOT EXISTS "reason" text;
  ALTER TABLE public."InspectionAssignment" ADD COLUMN IF NOT EXISTS "idempotencyKey" text;

  UPDATE public."InspectionAssignment" assignment
  SET "assignedById" = assignment."technicianId"
  WHERE "assignedById" IS NULL;
  ALTER TABLE public."InspectionAssignment" ALTER COLUMN "assignedById" SET NOT NULL;
END
$$;

ALTER TABLE public."Inspection" DROP CONSTRAINT IF EXISTS "Inspection_propertywareBuildingId_fkey";
ALTER TABLE public."Inspection" ADD CONSTRAINT "Inspection_propertywareBuildingId_fkey"
  FOREIGN KEY ("propertywareBuildingId") REFERENCES public.propertyware_buildings(id);
ALTER TABLE public."Inspection" DROP CONSTRAINT IF EXISTS "Inspection_propertywareUnitId_fkey";
ALTER TABLE public."Inspection" ADD CONSTRAINT "Inspection_propertywareUnitId_fkey"
  FOREIGN KEY ("propertywareUnitId") REFERENCES public.propertyware_units(id);
ALTER TABLE public."Inspection" DROP CONSTRAINT IF EXISTS "Inspection_propertywareLeaseId_fkey";
ALTER TABLE public."Inspection" ADD CONSTRAINT "Inspection_propertywareLeaseId_fkey"
  FOREIGN KEY ("propertywareLeaseId") REFERENCES public.propertyware_leases(id);

ALTER TABLE public."InspectionAssignment" DROP CONSTRAINT IF EXISTS "InspectionAssignment_assignedById_fkey";
ALTER TABLE public."InspectionAssignment" ADD CONSTRAINT "InspectionAssignment_assignedById_fkey"
  FOREIGN KEY ("assignedById") REFERENCES public."UserProfile"(id);
ALTER TABLE public."InspectionAssignment" DROP CONSTRAINT IF EXISTS "InspectionAssignment_endedById_fkey";
ALTER TABLE public."InspectionAssignment" ADD CONSTRAINT "InspectionAssignment_endedById_fkey"
  FOREIGN KEY ("endedById") REFERENCES public."UserProfile"(id);
ALTER TABLE public."InspectionAssignment" DROP CONSTRAINT IF EXISTS "InspectionAssignment_supersedesId_fkey";
ALTER TABLE public."InspectionAssignment" ADD CONSTRAINT "InspectionAssignment_supersedesId_fkey"
  FOREIGN KEY ("supersedesId") REFERENCES public."InspectionAssignment"(id);

DROP INDEX IF EXISTS public."InspectionAssignment_inspectionId_technicianId_key";
CREATE UNIQUE INDEX IF NOT EXISTS "InspectionAssignment_one_current_per_inspection_idx"
  ON public."InspectionAssignment" ("inspectionId") WHERE "isCurrent" = true;
CREATE UNIQUE INDEX IF NOT EXISTS "InspectionAssignment_supersedesId_key"
  ON public."InspectionAssignment" ("supersedesId") WHERE "supersedesId" IS NOT NULL;
CREATE UNIQUE INDEX IF NOT EXISTS "InspectionAssignment_idempotencyKey_key"
  ON public."InspectionAssignment" ("idempotencyKey") WHERE "idempotencyKey" IS NOT NULL;
CREATE INDEX IF NOT EXISTS "Inspection_organizationId_status_scheduledAt_idx"
  ON public."Inspection" ("organizationId", "status", "scheduledAt");
CREATE INDEX IF NOT EXISTS "InspectionAssignment_inspectionId_isCurrent_idx"
  ON public."InspectionAssignment" ("inspectionId", "isCurrent");
