-- Sessions signed in from the office console (the office, 2026-09-17).
--
-- Only the technician app is held to one signed-in device. The console marks its
-- sessions, so a technician-coordinator signing in at a desk is never refused or
-- made to sign a phone out, and a phone taking the account over leaves the
-- console alone. Sessions from before this are unmarked, and the console marks
-- its own on their next refresh.

-- AlterTable
ALTER TABLE "AuthRefreshToken" ADD COLUMN     "fromConsole" BOOLEAN NOT NULL DEFAULT false;
