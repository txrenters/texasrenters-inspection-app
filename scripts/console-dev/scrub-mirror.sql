-- Run after restoring a production dump into the LOCAL mirror database
-- (scripts/console-dev/restore-mirror.ps1 does it for you).
--
-- A copy of production carries live credentials for systems production talks
-- to. A backend booted against the copy must not be able to act on any of them,
-- so everything that would let it act outward, or let somebody act as a user,
-- goes before anything connects:
--
--   * Jobber tokens. Jobber rotates refresh tokens: a local backend refreshing
--     the copied token would retire PRODUCTION's, and production's Jobber
--     connection would die at its next refresh.
--   * Queued Jobber changes. The outbound worker would send them to the real
--     Jobber account.
--   * Phone push registrations. A push from the copy reaches a technician's
--     real phone.
--   * Sign-in sessions and password-reset links.
--   * Stored AI provider keys.
--
-- Nothing else is changed: the copy is for looking at, and it should look like
-- production.

BEGIN;

UPDATE "JobberConnection"
SET "accessTokenCiphertext" = NULL,
    "refreshTokenCiphertext" = NULL,
    "accessTokenExpiresAt" = NULL,
    "status" = 'DISCONNECTED';

DELETE FROM "JobberOutboundTask" WHERE "status" IN ('PENDING', 'FAILED');

DELETE FROM "MobilePushDevice";

DELETE FROM "AuthRefreshToken";
DELETE FROM "AuthPasswordResetToken";

UPDATE "AiProviderConfiguration" SET "encryptedApiKey" = NULL;

COMMIT;

SELECT
  (SELECT count(*) FROM "JobberConnection" WHERE "refreshTokenCiphertext" IS NOT NULL) AS jobber_tokens_left,
  (SELECT count(*) FROM "JobberOutboundTask" WHERE "status" IN ('PENDING', 'FAILED')) AS jobber_tasks_left,
  (SELECT count(*) FROM "MobilePushDevice") AS push_devices_left,
  (SELECT count(*) FROM "AuthRefreshToken") AS sessions_left,
  (SELECT count(*) FROM "AiProviderConfiguration" WHERE "encryptedApiKey" IS NOT NULL) AS ai_keys_left;
