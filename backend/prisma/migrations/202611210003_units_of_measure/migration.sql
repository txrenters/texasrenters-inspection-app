-- Units of measure (Purchasing Setup, part 5c, 2026-11-21): the units the
-- office's item codes already name become its first units, one a name. An
-- item keeps its unit as written ("each", "pack"); the list gives each a code
-- ("EACH", "PACK") and is where new ones are made.
--
-- Additive only: no item changes.
INSERT INTO "PurchasingCode" ("organizationId", "kind", "code", "name", "keepsStock")
SELECT u."organizationId", 'UNIT', u.code, u.name, false
FROM (
    SELECT DISTINCT ON (i."organizationId", c.code) i."organizationId", c.code, lower(btrim(i."unit")) AS name
    FROM "StockItem" i
    CROSS JOIN LATERAL (
        SELECT COALESCE(NULLIF(left(btrim(regexp_replace(upper(btrim(i."unit")), '[^A-Z0-9]+', '-', 'g'), '-'), 20), ''), 'UNIT') AS raw
    ) r
    CROSS JOIN LATERAL (SELECT rtrim(r.raw, '-') AS code) c
    WHERE btrim(i."unit") <> ''
    ORDER BY i."organizationId", c.code, lower(btrim(i."unit"))
) u
WHERE u.code ~ '^[A-Z0-9][A-Z0-9-]{0,19}$'
ON CONFLICT ("organizationId", "kind", "code") DO NOTHING;
