-- A person's phone number, so the office can call a technician from their page
-- (the user, 2026-10-14). Optional and additive: every existing account has
-- none until somebody types it in. Stored in E.164 by the API
-- (`normalizePhoneNumber`), never as typed.
ALTER TABLE "UserProfile" ADD COLUMN "phone" TEXT;
