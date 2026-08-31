-- Close the create-vs-create race on inspection booking.
--
-- `resolveInspectionPlan` refuses a second live inspection of the same type, on
-- the same day, for the same unit — but that was a findFirst with nothing behind
-- it, so two concurrent creates could both pass and both insert. Rare when the
-- office books by hand; genuinely reachable now the Jobber sync writes on a
-- schedule.
--
-- SCOPED TO 'SCHEDULED', NOT TO EVERY NON-TERMINAL STATUS.
--
-- The obvious index — WHERE status NOT IN ('COMPLETED','CANCELLED') — matches
-- the application rule but breaks reopening. COMPLETED is a reopenable status,
-- so reopening moves a row back into that predicate; and because terminal work
-- deliberately does NOT clash, a completed move-in and a newly booked one can
-- legitimately share a day. Reopening the completed one would then collide and
-- fail. Reopening is how a record gets corrected, not how a visit gets booked,
-- so it must not be refused by a booking rule.
--
-- Every create inserts SCHEDULED, so this predicate catches every create-vs-create
-- race — the one this index exists for — and never fires on a later transition.
-- The broader rule (no second LIVE inspection, including one already in progress)
-- stays enforced in application code, where it can explain itself.
--
-- NULLS NOT DISTINCT because propertywareUnitId and propertywareBuildingId are
-- both nullable, and the application check matches NULL explicitly: an "entire
-- property" booking has no unit, and two of those must still collide. Default
-- unique semantics treat NULLs as distinct and would let exactly those through,
-- making the index quietly weaker than the check it backs.
--
-- Prisma cannot express a partial index, so this lives only in SQL; the schema
-- carries a comment pointing here.
CREATE UNIQUE INDEX "Inspection_scheduled_booking_key"
    ON "Inspection" (
        "organizationId",
        "propertywareBuildingId",
        "propertywareUnitId",
        "inspectionType",
        "scheduledAt"
    )
    NULLS NOT DISTINCT
    WHERE status = 'SCHEDULED';
