-- A Propertyware building may have no portfolio.
--
-- Requiring one made the sync quarantine every such building: nineteen real
-- properties were rejected with "portfolioID: expected string, received null"
-- and never appeared in the app at all. The constraint was an assumption that
-- held until the account contained a building without one.
--
-- Widening only. No existing row loses its portfolio, and the foreign key still
-- holds for every row that has one.
ALTER TABLE "propertyware_buildings"
  ALTER COLUMN "portfolioId" DROP NOT NULL,
  ALTER COLUMN "externalPortfolioId" DROP NOT NULL;

-- An optional relation carries SET NULL rather than RESTRICT: deleting a
-- portfolio now orphans its buildings instead of refusing, which is the same
-- state a building that never had one is already in.
ALTER TABLE "propertyware_buildings"
  DROP CONSTRAINT "propertyware_buildings_portfolioId_fkey";
ALTER TABLE "propertyware_buildings"
  ADD CONSTRAINT "propertyware_buildings_portfolioId_fkey"
  FOREIGN KEY ("portfolioId") REFERENCES "propertyware_portfolios"("id")
  ON DELETE SET NULL ON UPDATE CASCADE;
