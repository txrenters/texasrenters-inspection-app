-- The report's closing block, written by the reviewer at sign-off.
--
-- Three separate columns rather than one note because the office's printed
-- report prints them as three headed columns, and they are read by different
-- people: the alert schedules the next visit, the maintenance comments become
-- work orders, and the general comments are what the tenant reads. Merging them
-- would force whoever reads one to sift the other two.
--
-- All nullable: a report is publishable without any of them, and an empty
-- string would print a heading over nothing.
ALTER TABLE "Inspection" ADD COLUMN "nextInspectionAlert" TEXT;
ALTER TABLE "Inspection" ADD COLUMN "maintenanceComments" TEXT;
ALTER TABLE "Inspection" ADD COLUMN "generalComments" TEXT;
