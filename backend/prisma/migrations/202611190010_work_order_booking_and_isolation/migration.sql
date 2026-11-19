-- Two things the work-order intake (202611190009) needed and did not have.
--
-- 1. The same-day booking rule stands aside for work orders in the database
--    too, not only in code. `resolveInspectionPlan` skips the duplicate check
--    for a work order's visit, but `Inspection_scheduled_booking_key` -- the
--    partial unique index from 202608310006 -- still refused a second
--    SCHEDULED maintenance visit at the same property on the same day, and
--    most work orders arrive undated and are all booked for the day they came
--    in. The sender was answered 409 and took it as final. Two repairs at one
--    property on one day are two work orders; the work order's own unique key
--    (organizationId, workOrderKey) is what says whether two are the same.
--
--    Same columns, same NULLS NOT DISTINCT, same SCHEDULED scope; only rows
--    with source = 'WORK_ORDER' are left out. Every other booking keeps the
--    guard it had, including the create-vs-create race it exists for. Dropped
--    and re-created under the same name so the schema's note still points at
--    one index.
--
-- 2. `WorkOrderImport` holds the whole envelope -- tenant names, phones,
--    emails and notes marked private -- and was the one recent table without
--    the tenant isolation policy every other one carries.

DROP INDEX IF EXISTS "Inspection_scheduled_booking_key";
CREATE UNIQUE INDEX "Inspection_scheduled_booking_key"
    ON "Inspection" (
        "organizationId",
        "propertywareBuildingId",
        "propertywareUnitId",
        "inspectionType",
        "scheduledAt"
    )
    NULLS NOT DISTINCT
    WHERE status = 'SCHEDULED' AND "source" <> 'WORK_ORDER';

ALTER TABLE "WorkOrderImport" ENABLE ROW LEVEL SECURITY;
CREATE POLICY "tenant_isolation" ON "WorkOrderImport"
  USING (
    current_setting('app.organization_id', true) = '*'
    OR "organizationId"::text = current_setting('app.organization_id', true)
  );
