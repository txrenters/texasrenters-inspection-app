-- Mirror of Prisma migration 202607240003_area_environment_and_manual_areas.
-- Area environment/category classification, manual-area provenance, soft archive, and aliases.
CREATE TYPE "AreaEnvironment" AS ENUM ('INDOOR', 'OUTDOOR', 'SEMI_OUTDOOR');
CREATE TYPE "AreaCategory" AS ENUM (
  'INDOOR_ROOM', 'HALLWAY', 'STAIRWAY', 'CLOSET', 'UTILITY', 'GARAGE', 'ATTIC',
  'BASEMENT', 'BALCONY', 'PATIO', 'PORCH', 'DRIVEWAY', 'YARD', 'EXTERIOR_WALL',
  'ROOF', 'PERIMETER_FENCE', 'GATE', 'POOL', 'SHED', 'OTHER_OUTDOOR', 'OTHER'
);

ALTER TABLE "PropertyArea"
  ADD COLUMN "environment" "AreaEnvironment" NOT NULL DEFAULT 'INDOOR',
  ADD COLUMN "category" "AreaCategory",
  ADD COLUMN "notes" TEXT,
  ADD COLUMN "createdById" UUID,
  ADD COLUMN "archivedAt" TIMESTAMP(3);

ALTER TABLE "PropertyArea"
  ADD CONSTRAINT "PropertyArea_createdById_fkey"
  FOREIGN KEY ("createdById") REFERENCES "UserProfile"("id") ON DELETE SET NULL ON UPDATE CASCADE;

CREATE TABLE "PropertyAreaAlias" (
  "id" UUID NOT NULL,
  "propertyAreaId" UUID NOT NULL,
  "alias" TEXT NOT NULL,
  "createdById" UUID,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "PropertyAreaAlias_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX "PropertyAreaAlias_propertyAreaId_alias_key" ON "PropertyAreaAlias"("propertyAreaId", "alias");
CREATE INDEX "PropertyAreaAlias_propertyAreaId_idx" ON "PropertyAreaAlias"("propertyAreaId");
ALTER TABLE "PropertyAreaAlias"
  ADD CONSTRAINT "PropertyAreaAlias_propertyAreaId_fkey"
  FOREIGN KEY ("propertyAreaId") REFERENCES "PropertyArea"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "PropertyAreaAlias"
  ADD CONSTRAINT "PropertyAreaAlias_createdById_fkey"
  FOREIGN KEY ("createdById") REFERENCES "UserProfile"("id") ON DELETE SET NULL ON UPDATE CASCADE;
