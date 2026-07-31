-- Admin-authored coverage checklist, one list per property area.
--
-- Ticking is the technician's own record of what they covered while recording.
-- It never gates completing an area: the walkthrough video remains the
-- evidence, and an untouched checkbox is not proof that something was missed.

CREATE TABLE "AreaChecklistItem" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "organizationId" UUID NOT NULL,
    "propertyAreaId" UUID NOT NULL,
    "label" TEXT NOT NULL,
    -- Spoken words that count as covering this item, matched against the
    -- recording's transcript. Empty means it can only be ticked by hand.
    "keywords" TEXT[] NOT NULL DEFAULT ARRAY[]::TEXT[],
    "sortOrder" INTEGER NOT NULL DEFAULT 0,
    -- Soft delete: a removed item must not vanish from inspections that already
    -- recorded coverage against it.
    "archivedAt" TIMESTAMP(3),
    "createdById" UUID,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "AreaChecklistItem_pkey" PRIMARY KEY ("id")
);

-- The same wording twice in one area is a mistake, not a second item.
CREATE UNIQUE INDEX "AreaChecklistItem_propertyAreaId_label_key"
    ON "AreaChecklistItem"("propertyAreaId", "label");

-- Serves the technician's read: every item for one area, already ordered.
CREATE INDEX "AreaChecklistItem_propertyAreaId_sortOrder_idx"
    ON "AreaChecklistItem"("propertyAreaId", "sortOrder");

CREATE INDEX "AreaChecklistItem_organizationId_idx"
    ON "AreaChecklistItem"("organizationId");

ALTER TABLE "AreaChecklistItem"
    ADD CONSTRAINT "AreaChecklistItem_organizationId_fkey"
    FOREIGN KEY ("organizationId") REFERENCES "Organization"("id")
    ON DELETE RESTRICT ON UPDATE CASCADE;

-- Cascade: an area that no longer exists cannot have a checklist.
ALTER TABLE "AreaChecklistItem"
    ADD CONSTRAINT "AreaChecklistItem_propertyAreaId_fkey"
    FOREIGN KEY ("propertyAreaId") REFERENCES "PropertyArea"("id")
    ON DELETE CASCADE ON UPDATE CASCADE;

-- SetNull, not cascade: removing the administrator who wrote an item must not
-- delete the item itself.
ALTER TABLE "AreaChecklistItem"
    ADD CONSTRAINT "AreaChecklistItem_createdById_fkey"
    FOREIGN KEY ("createdById") REFERENCES "UserProfile"("id")
    ON DELETE SET NULL ON UPDATE CASCADE;
