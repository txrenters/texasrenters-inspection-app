-- The technician's report on the services a Jobber visit booked, and when it
-- was noted in Jobber.
--
-- Every benefit-package visit asks the technician to "indicate in the notes which
-- services were completed by using the corresponding numbers", typed into Jobber
-- by hand. The app now asks at submission instead: each service done or not,
-- why not, and whether it has to be booked again.
ALTER TABLE "Inspection" ADD COLUMN "servicesReport" JSONB;
ALTER TABLE "Inspection" ADD COLUMN "servicesReportedAt" TIMESTAMP(3);

-- The note goes before the completion, so a retry must know it already went.
ALTER TABLE "JobberOutboundTask" ADD COLUMN "servicesNoteSentAt" TIMESTAMP(3);
