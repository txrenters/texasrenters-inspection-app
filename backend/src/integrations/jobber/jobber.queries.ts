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
export const VISITS_QUERY = `
  query InspectionVisits($first: Int!, $after: String, $startAfter: ISO8601DateTime, $startBefore: ISO8601DateTime) {
    visits(
      first: $first
      after: $after
      filter: { startAt: { after: $startAfter, before: $startBefore } }
    ) {
      nodes {
        id
        title
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
 * `userErrors` is selected because Jobber reports business-rule rejections
 * there, inside an otherwise successful response — a mutation that returns no
 * top-level error has still not necessarily done anything.
 */
export const VISIT_COMPLETE_MUTATION = `
  mutation CompleteVisit($visitId: EncodedId!) {
    visitComplete(visitId: $visitId) {
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
 * Attaches a note to the job the visit belongs to.
 *
 * The note carries the report link, so the office sees the finished inspection
 * from the job they scheduled. Whether such a note is visible in Jobber's
 * client hub is account configuration we cannot read from here, which is why
 * sending the link at all is behind JOBBER_PUSH_REPORT_LINK.
 */
export const JOB_NOTE_CREATE_MUTATION = `
  mutation CreateJobNote($jobId: EncodedId!, $message: String!) {
    jobNoteCreate(jobId: $jobId, input: { message: $message }) {
      userErrors {
        message
        path
      }
    }
  }
`;
