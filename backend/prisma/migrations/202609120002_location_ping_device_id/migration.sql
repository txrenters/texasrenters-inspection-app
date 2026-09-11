-- The id the handset already generates for each fix, so a retried upload stops
-- writing the same position twice.
--
-- Nullable, and deliberately not backfilled: every existing row was written
-- without one and there is nothing to derive. Postgres treats NULLs as
-- distinct in a unique index, so the constraint below leaves all of them
-- alone and only constrains rows written from here on.
ALTER TABLE "TechnicianLocationPing" ADD COLUMN "deviceFixId" TEXT;

-- Scoped to the technician rather than global: the id is generated on the
-- device, so two handsets can produce the same string. Scoping makes a
-- collision between them impossible rather than merely unlikely.
CREATE UNIQUE INDEX "TechnicianLocationPing_technicianId_deviceFixId_key"
  ON "TechnicianLocationPing" ("technicianId", "deviceFixId");
