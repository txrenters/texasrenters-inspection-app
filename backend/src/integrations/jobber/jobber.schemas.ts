import { z } from 'zod';

/**
 * What a Jobber response must look like before any of it is believed.
 *
 * The sync writes inspections that send people to addresses, so a response that
 * is not the shape this code expects is a failure, not something to work around
 * with optional chaining. Validating at the boundary means a Jobber schema
 * change surfaces as one clear error on the first page instead of as a run that
 * imports half the fields and reports success.
 */

const address = z.object({
  street1: z.string().nullish(),
  street2: z.string().nullish(),
  city: z.string().nullish(),
  province: z.string().nullish(),
  postalCode: z.string().nullish(),
});

export const jobberVisitSchema = z.object({
  id: z.string().min(1),
  title: z.string().nullish(),
  // Null for an unscheduled visit. Not an error and not a default: a visit
  // Jobber has not placed on a day cannot become an inspection, and the worker
  // holds it rather than inventing a date.
  startAt: z.string().datetime({ offset: true }).nullish(),
  endAt: z.string().datetime({ offset: true }).nullish(),
  completedAt: z.string().datetime({ offset: true }).nullish(),
  createdAt: z.string().datetime({ offset: true }).nullish(),
  visitStatus: z.string().nullish(),
  // Jobber returns a startAt even for all-day visits, so this is the only
  // reliable way to know the visit has no real clock time.
  allDay: z.boolean().nullish(),
  job: z.object({ id: z.string(), jobNumber: z.union([z.string(), z.number()]).nullish() }).nullish(),
  client: z.object({ id: z.string(), name: z.string().nullish() }).nullish(),
  // The property is what the whole mapping layer keys on. A visit without one
  // can never become an inspection, so it is nullable here and rejected with a
  // named reason rather than silently skipped.
  property: z.object({ id: z.string(), address: address.nullish() }).nullish(),
});

export const jobberVisitsPageSchema = z.object({
  visits: z.object({
    nodes: z.array(jobberVisitSchema),
    pageInfo: z.object({ hasNextPage: z.boolean(), endCursor: z.string().nullish() }),
  }),
});

export type JobberVisit = z.infer<typeof jobberVisitSchema>;
export type JobberVisitsPage = z.infer<typeof jobberVisitsPageSchema>;
