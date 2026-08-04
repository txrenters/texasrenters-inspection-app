-- Makes a retried pet observation record one sighting.
--
-- This is the only technician write that appends rather than sets a value:
-- note, skip and complete all land on the same state applied once or twice,
-- and media and area creation already carry keys. Without this, a request
-- whose response was lost records the same animal again on retry — and a
-- duplicate pet is a charge somebody has to argue about.
--
-- Nullable, so observations recorded before this column existed keep their
-- rows, and a client that sends no key behaves exactly as it does today. The
-- unique index ignores NULLs in Postgres, so those rows do not collide.
ALTER TABLE "PetObservation"
  ADD COLUMN "idempotencyKey" TEXT;

CREATE UNIQUE INDEX "PetObservation_idempotencyKey_key"
  ON "PetObservation" ("idempotencyKey");
