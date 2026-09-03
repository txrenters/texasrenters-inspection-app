-- Records that an import's evidence has actually been written, so a finished
-- reading and a finished import are never confused for each other.
--
-- A migration of its own, because 202609030002 had already been applied when
-- this column was wanted. Editing that file instead added the column to the
-- source and to no database: Prisma applies a migration once, by name, and an
-- edit afterwards changes nothing that already ran. Production then answered
-- 500 on every poll of an import job -- "the column
-- InspectionImportJob.committedAt does not exist in the current database" --
-- while the code that read it was perfectly correct.
--
-- IF NOT EXISTS so it is a no-op where the column was already created by hand
-- to unblock production, and still records itself properly on the next deploy.
ALTER TABLE "InspectionImportJob"
    ADD COLUMN IF NOT EXISTS "committedAt" TIMESTAMP(3);
