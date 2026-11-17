-- A technician's log tab is taken over from the sync's first day (2026-11-18;
-- the office: "Yes, take them over"): the office's rows from that day are
-- brought into the console and the console's rows take their place, so each
-- visit is on the tab once. The day it was taken over from is kept: a first
-- day moved earlier takes it over again from there.

ALTER TABLE "ExcelSyncSheet" ADD COLUMN "adoptedFrom" DATE;
