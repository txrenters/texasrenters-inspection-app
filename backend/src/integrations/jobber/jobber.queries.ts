/**
 * Every GraphQL document sent to Jobber, in one file.
 *
 * Kept together and kept small because query *shape* is what costs money here:
 * Jobber prices a connection as `first` × the number of requested fields, so an
 * extra field on a 50-node page costs 50 points, not one. Nothing is selected
 * that the sync does not use.
 *
 * VERIFY BEFORE FIRST RUN: the field selection below follows Jobber's
 * documented Relay conventions and the published Visit type, but it has not
 * been run against a live schema — this backend has never held a token. Open
 * GraphiQL in the Developer Center once connected and confirm the selection
 * against the pinned `JOBBER_API_VERSION`. `jobber.schemas.ts` validates every
 * response, so a mismatch fails loudly on the first page rather than importing
 * partial data.
 */

/**
 * Visits in a date window, newest page first.
 *
 * There is deliberately no `updatedAt`: it does not exist on Jobber's `Visit`
 * type, which is what the first live run of this query proved. A reschedule is
 * therefore detected by comparing `startAt`/`endAt` against what we stored,
 * which is a better signal anyway — it notices the change we actually care
 * about rather than any edit to any field.
 *
 * A window rather than an "updated since" cursor: what this sync cares about is
 * the *schedule*, and a visit moved from next week to next month has to be seen
 * in both windows for the move to be noticed. `first` is always supplied — an
 * omitted one is priced as 100 nodes whatever the page actually returns.
 */
/**
 * The line Jobber shows under "Details" on a visit.
 *
 * Optional because it is the one field here whose name is not proven against
 * this account's pinned schema. Everything else has been returning data for
 * months; this was added to read "+ Occupied Inspection" out of a Tenant
 * Benefit Package visit, and an unknown field name fails the *entire* query --
 * which would stop the whole sync to gain one enrichment.
 *
 * So it is spliced in, and `JobberSyncWorker.fetchVisitsPage` drops it and
 * retries once if Jobber says it does not exist. The sync then runs exactly as
 * it did before, with a log saying why the occupied-inspection rule cannot
 * fire.
 */
export const VISIT_DETAILS_FIELD = 'instructions';

export const visitsQuery = (detailsField: string | null = VISIT_DETAILS_FIELD) => `
  query InspectionVisits($first: Int!, $after: String, $startAfter: ISO8601DateTime, $startBefore: ISO8601DateTime) {
    visits(
      first: $first
      after: $after
      filter: { startAt: { after: $startAfter, before: $startBefore } }
    ) {
      nodes {
        id
        title
        ${detailsField ?? ''}
        startAt
        endAt
        completedAt
        createdAt
        visitStatus
        # True when the visit was booked to a day with no time. Jobber still
        # returns a startAt for these, so without it an all-day visit would
        # render as whatever midnight is in the reader's timezone.
        allDay
        job {
          id
          jobNumber
        }
        client {
          id
          name
        }
        assignedUsers(first: 3) {
          nodes {
            id
            email {
              raw
            }
            name {
              full
            }
          }
        }
        property {
          id
          address {
            street1
            street2
            city
            province
            postalCode
          }
        }
      }
      pageInfo {
        hasNextPage
        endCursor
      }
    }
  }
`;

export const ACCOUNT_QUERY = 'query GetAccount { account { id name } }';

/**
 * Marks a Jobber visit complete.
 *
 * `input.completedAt` carries our own finalization time. It is optional to
 * Jobber, but omitting it lets Jobber stamp the moment the outbox happened to
 * drain — which can be hours after sign-off, and is not when the work finished.
 *
 * `userErrors` is selected because Jobber reports business-rule rejections
 * there, inside an otherwise successful response — a mutation that returns no
 * top-level error has still not necessarily done anything.
 */
export const VISIT_COMPLETE_MUTATION = `
  mutation CompleteVisit($visitId: EncodedId!, $input: VisitCompleteInput) {
    visitComplete(visitId: $visitId, input: $input) {
      visit {
        id
        completedAt
      }
      userErrors {
        message
        path
      }
    }
  }
`;

/**
 * Books a visit on a job that already exists.
 *
 * **Verified against the live schema on API version 2025-01-20**, not guessed —
 * `jobCreateNote` below records what guessing costs. Confirmed by
 * introspection:
 *
 *   visitCreate(jobId: EncodedId, input: VisitCreateInput): VisitCreatePayload
 *   VisitCreateInput        { visits: [VisitCreateAttributes]! }
 *   VisitCreateAttributes   { title, instructions, overrideOrder, schedule }
 *   ScheduledItemAttributes { notifyTeam, teamReminderOffset, startAt, endAt,
 *                             teamMemberIdsToAssign }
 *   LocalDateTimeAttributes { date: ISO8601Date!, time: ISO8601Time,
 *                             timezone: Timezone! }
 *   VisitCreatePayload      { createdVisits, job, userErrors }
 *
 * Two things that settle open questions elsewhere in this integration.
 * **`instructions` is writable on create**, so the "+ Occupied Inspection"
 * phrase the importer keys on can actually be set — see
 * `occupiedInspectionInDetails`. And **`time` is optional while `date` and
 * `timezone` are not**, so a visit can be booked for a whole day, which is
 * exactly the shape of `Inspection.scheduledAt` (`@db.Date`).
 *
 * The variables are declared non-null even though the arguments are nullable.
 * GraphQL permits a `T!` variable wherever `T` is accepted, and being stricter
 * here means a missing id fails locally rather than at Jobber.
 *
 * **This is not sufficient for the quarterly planner on its own.** Every one of
 * the 115 benefit-package visits in the live table belongs to its own job —
 * 115 visits, 115 distinct jobs — so the office creates a job per visit rather
 * than adding visits to a recurring one. Booking a new quarter therefore needs
 * `jobCreate` first, whose `invoicing` argument is required and carries two
 * enums (`BillingStrategy`, `BillingFrequencyEnum`) that decide how the office
 * bills. That is a business decision, not a technical one, and it is why the
 * outbound worker still refuses TBP_VISIT_CREATE.
 */
export const VISIT_CREATE_MUTATION = `
  mutation CreateVisit($jobId: EncodedId!, $input: VisitCreateInput!) {
    visitCreate(jobId: $jobId, input: $input) {
      createdVisits {
        id
        title
        startAt
      }
      userErrors {
        message
        path
      }
    }
  }
`;

/**
 * Attaches a note to the job the visit belongs to.
 *
 * `jobCreateNote`, not `jobNoteCreate`. The latter was a guess and does not
 * exist; every report-link push would have failed on it. Verified against the
 * live schema.
 *
 * The note carries the report link, so the office sees the finished inspection
 * from the job they scheduled. Whether such a note is visible in Jobber's
 * client hub is account configuration we cannot read from here, which is why
 * sending the link at all is behind JOBBER_PUSH_REPORT_LINK.
 */
export const JOB_NOTE_CREATE_MUTATION = `
  mutation CreateJobNote($jobId: EncodedId!, $input: JobCreateNoteInput!) {
    jobCreateNote(jobId: $jobId, input: $input) {
      userErrors {
        message
        path
      }
    }
  }
`;

/**
 * One visit, by Jobber id.
 *
 * Used by the webhook path, which is told *that* a visit changed and must then
 * fetch it — the payload carries only an id.
 *
 * Filtered by `ids` rather than a `visit(id:)` root field, because `ids` is a
 * confirmed member of `VisitFilterAttributes` and this reuses the node
 * selection the paged query already proved against the live schema. Inventing a
 * second shape here is how the last three defects got in.
 */
export const VISIT_BY_ID_QUERY = `
  query InspectionVisitById($ids: [EncodedId!]) {
    visits(first: 1, filter: { ids: $ids }) {
      nodes {
        id
        title
        startAt
        endAt
        completedAt
        createdAt
        visitStatus
        allDay
        job {
          id
          jobNumber
        }
        client {
          id
          name
        }
        assignedUsers(first: 3) {
          nodes {
            id
            email {
              raw
            }
            name {
              full
            }
          }
        }
        property {
          id
          address {
            street1
            street2
            city
            province
            postalCode
          }
        }
      }
      pageInfo {
        hasNextPage
        endCursor
      }
    }
  }
`;
