-- Removing stock with a reason, and deleting an item code (2026-11-24, from the
-- approved RemoveStock and DeleteItem boards of the Inventory Screens canvas).
--
-- The ledger stays written once: stock leaves by a REMOVAL movement that says
-- why, and Reverse puts it back. An item code that has been used is deleted by
-- marking it so: it leaves every list, its code is free for a new item, and the
-- documents that named it keep their lines. An item nothing names is removed.
--
-- Additive only: no row is changed.

-- A value added to an enum is not used in the transaction that adds it, so the
-- checks below compare the kind as text.
ALTER TYPE "StockMovementKind" ADD VALUE IF NOT EXISTS 'REMOVAL';

CREATE TYPE "StockRemovalReason" AS ENUM ('TESTING', 'DAMAGED', 'LOST', 'USED_NOT_RECORDED', 'ENTERED_BY_MISTAKE', 'OTHER');

ALTER TABLE "StockMovement" ADD COLUMN "removalReason" "StockRemovalReason";

-- A removal always says why, and nothing else carries a removal reason.
ALTER TABLE "StockMovement" ADD CONSTRAINT "StockMovement_removal_says_why" CHECK (("kind"::text = 'REMOVAL') = ("removalReason" IS NOT NULL));
-- A removal takes stock out.
ALTER TABLE "StockMovement" ADD CONSTRAINT "StockMovement_removal_is_out" CHECK ("kind"::text <> 'REMOVAL' OR "quantity" < 0);
-- "Other" is said in words.
ALTER TABLE "StockMovement" ADD CONSTRAINT "StockMovement_other_removal_has_note" CHECK ("removalReason" IS DISTINCT FROM 'OTHER' OR length(btrim(coalesce("note", ''))) > 0);

CREATE TYPE "StockItemDeleteReason" AS ENUM ('TESTING', 'MADE_BY_MISTAKE', 'DUPLICATE', 'OTHER');

ALTER TABLE "StockItem"
    ADD COLUMN "deletedAt" TIMESTAMP(3),
    ADD COLUMN "deletedById" UUID,
    ADD COLUMN "deletedByName" TEXT,
    ADD COLUMN "deleteReason" "StockItemDeleteReason",
    ADD COLUMN "deleteNote" TEXT;

-- Deleted means switched off, with who and why.
ALTER TABLE "StockItem" ADD CONSTRAINT "StockItem_deleted_is_switched_off" CHECK ("deletedAt" IS NULL OR ("active" = false AND "deletedByName" IS NOT NULL));
ALTER TABLE "StockItem" ADD CONSTRAINT "StockItem_delete_reason_when_deleted" CHECK (("deletedAt" IS NULL) = ("deleteReason" IS NULL));
ALTER TABLE "StockItem" ADD CONSTRAINT "StockItem_other_delete_has_note" CHECK ("deleteReason" IS DISTINCT FROM 'OTHER' OR length(btrim(coalesce("deleteNote", ''))) > 0);

-- A deletion is never undone: the code it gave up may already be another item's.
CREATE FUNCTION "StockItem_stays_deleted"() RETURNS trigger AS $$
BEGIN
    IF OLD."deletedAt" IS NOT NULL AND (NEW."deletedAt" IS NULL OR NEW."active") THEN
        RAISE EXCEPTION 'StockItem_stays_deleted: a deleted item code is not brought back. Add a new one.'
            USING ERRCODE = 'restrict_violation';
    END IF;
    RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER "StockItem_stays_deleted"
    BEFORE UPDATE ON "StockItem"
    FOR EACH ROW EXECUTE FUNCTION "StockItem_stays_deleted"();
