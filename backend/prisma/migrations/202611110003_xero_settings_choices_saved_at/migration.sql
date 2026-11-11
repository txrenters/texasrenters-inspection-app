-- When somebody last saved a company's Xero choices (2026-11-11): the
-- settings page's guard against overwriting a newer save. It was the row's
-- updatedAt, which turning sending on and every sending run also move (the
-- run's claim, its last run), so with sending on, a page left open across a
-- ten-minute run could not save -- "Somebody changed these" -- until reloaded.
ALTER TABLE "XeroSettings" ADD COLUMN "choicesUpdatedAt" TIMESTAMP(3);
UPDATE "XeroSettings" SET "choicesUpdatedAt" = "updatedAt";
ALTER TABLE "XeroSettings" ALTER COLUMN "choicesUpdatedAt" SET NOT NULL;
ALTER TABLE "XeroSettings" ALTER COLUMN "choicesUpdatedAt" SET DEFAULT CURRENT_TIMESTAMP;
