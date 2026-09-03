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
  /**
   * The line Jobber shows under Details on a visit.
   *
   * Optional twice over: Jobber may not set it, and the query omits the field
   * entirely if this account schema rejects the name.
   */
  instructions: z.string().nullish(),
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
  /**
   * Who the coordinator put on the visit.
   *
   * Invisible without the Users scope — Jobber returns an empty list rather
   * than an error — so an absent assignee proves nothing about the schedule,
   * only about the app's permissions.
   */
  assignedUsers: z
    .object({
      nodes: z.array(
        z.object({
          id: z.string(),
          email: z.object({ raw: z.string().nullish() }).nullish(),
          name: z.object({ full: z.string().nullish() }).nullish(),
        }),
      ),
    })
    .nullish(),
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

/**
 * The webhook body Jobber posts.
 *
 * It carries no object data — only which topic fired, on which account, for
 * which id. Everything else has to be fetched, which is why a webhook replaces
 * the polling rather than the sync itself.
 *
 * `occurredAt` is spelled correctly only for apps created after 8 December
 * 2023; older ones receive `occuredAt`. Ours is new, but both are accepted
 * because the cost is one optional field and the failure is a silent one.
 */
export const jobberWebhookSchema = z.object({
  data: z.object({
    webHookEvent: z.object({
      topic: z.string().min(1),
      appId: z.string().nullish(),
      accountId: z.string().min(1),
      itemId: z.string().min(1),
      occurredAt: z.string().nullish(),
      occuredAt: z.string().nullish(),
    }),
  }),
});

export type JobberWebhookEvent = z.infer<typeof jobberWebhookSchema>['data']['webHookEvent'];
