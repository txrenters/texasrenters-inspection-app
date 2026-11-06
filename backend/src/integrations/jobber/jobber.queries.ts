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
 * **This is not sufficient on its own**, because it needs a job to hang the
 * visit on. Every one of the 115 benefit-package visits in the live table
 * belongs to its own job — 115 visits, 115 distinct jobs — so the office
 * creates a job per visit rather than adding visits to a recurring one.
 * `JOB_CREATE_MUTATION` below is the other half.
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
 * The one-off job a benefit-package visit hangs on.
 *
 * Verified against the live schema, and — more usefully — against the office's
 * **own existing jobs**, so this copies what they already do rather than
 * choosing on their behalf. Three of the jobs behind live TBP visits read:
 *
 *   jobType ONE_OFF, billingType FIXED_PRICE, billingFrequency ON_COMPLETION
 *   title "Zone 1 - Q3 2026 Tenant Benefit Package"
 *
 * `invoicing` is a required argument carrying two enums that decide how a
 * client is billed, which is not a decision this code should invent. Reading it
 * off their existing jobs is why `TBP_JOB_INVOICING` below is a fact rather
 * than a default.
 *
 * Note the **job** title carries no address while the **visit** title does —
 * `19412 Lookalike Bridge Ln - Zone 1 - Q3 2026 Tenant Benefit Package`. That is
 * the office's own convention and the visit title is the one
 * `resolveVisitType` reads, so the two are built separately rather than one
 * being derived from the other.
 *
 * Scheduling is deliberately omitted here. `JobSchedulingAttributes.createVisits`
 * would have Jobber mint the visit itself, and then the visit's title and
 * instructions are whatever Jobber derives — including the
 * "+ Occupied Inspection" phrase the importer depends on. Creating the job bare
 * and then calling `visitCreate` keeps both strings under our control.
 */
export const JOB_CREATE_MUTATION = `
  mutation CreateJob($input: JobCreateAttributes!) {
    jobCreate(input: $input) {
      job {
        id
        jobNumber
      }
      userErrors {
        message
        path
      }
    }
  }
`;

/**
 * How the office bills a benefit-package job, read from their own jobs.
 *
 * Not a default and not a guess: three live TBP jobs were inspected and all
 * three carry exactly this. If the office changes how they bill the programme,
 * this is the line that has to change with it.
 */
export const TBP_JOB_INVOICING = {
  invoicingType: 'FIXED_PRICE',
  invoicingSchedule: 'ON_COMPLETION',
} as const;

/**
 * The edits the console pushes to a visit Jobber already has.
 *
 * Signatures verified against the live schema on 2026-09-15, and their payloads
 * on a second read-only check the same day: every one returns
 * `userErrors: [MutationErrors!]!`, the shape `visitComplete` has been answering
 * with in production. Each selects nothing else -- the worker only needs to know
 * Jobber accepted the change.
 *
 *   visitEdit(id, attributes: { title, instructions })
 *   visitEditSchedule(id, input: { startAt, endAt: { date!, time, timezone! } })
 *   visitEditAssignedUsers(visitId, input: { assignedUserIds! })
 *   jobClose(jobId, input: { modifyIncompleteVisitsBy: DESTROY_ALL | COMPLETE_PAST_DESTROY_FUTURE })
 *   visitDelete(visitIds!)
 */
export const VISIT_EDIT_MUTATION = `
  mutation EditVisit($id: EncodedId!, $attributes: VisitEditAttributes!) {
    visitEdit(id: $id, attributes: $attributes) {
      userErrors {
        message
        path
      }
    }
  }
`;

export const VISIT_EDIT_SCHEDULE_MUTATION = `
  mutation RescheduleVisit($id: EncodedId!, $input: VisitEditScheduleInput!) {
    visitEditSchedule(id: $id, input: $input) {
      userErrors {
        message
        path
      }
    }
  }
`;

export const VISIT_EDIT_ASSIGNED_USERS_MUTATION = `
  mutation AssignVisit($visitId: EncodedId!, $input: VisitEditAssignedUsersInput!) {
    visitEditAssignedUsers(visitId: $visitId, input: $input) {
      userErrors {
        message
        path
      }
    }
  }
`;

/**
 * Closes a job and removes its visits not yet done.
 *
 * `DESTROY_ALL`, which the office chose for a cancelled inspection: the visit
 * leaves the technician's schedule and the job stays as closed history, which
 * `jobReopen` can undo. Used only when the job holds no other visit this system
 * knows of; otherwise just the one visit is deleted.
 */
export const JOB_CLOSE_MUTATION = `
  mutation CloseJob($jobId: EncodedId!, $input: JobCloseInput!) {
    jobClose(jobId: $jobId, input: $input) {
      userErrors {
        message
        path
      }
    }
  }
`;

/**
 * The visits on one job, to decide whether closing it takes anything else off
 * the schedule.
 *
 * Asked of Jobber at the moment of cancelling rather than read from the visits
 * this system imported: those cover the sync's window only, and a job's visit
 * two months out would be invisible to it and destroyed by the close.
 * `job(id:)`, `Job.visits` and `Visit.isComplete` are verified; the page shape
 * is the one the paged visit query already uses.
 */
export const JOB_VISITS_QUERY = `
  query JobVisits($id: EncodedId!) {
    job(id: $id) {
      visits(first: 50) {
        nodes {
          id
          isComplete
        }
        pageInfo {
          hasNextPage
        }
      }
    }
  }
`;

export const VISIT_DELETE_MUTATION = `
  mutation DeleteVisits($visitIds: [EncodedId!]!) {
    visitDelete(visitIds: $visitIds) {
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
 *
 * Asks for the Details too. It was left out while the field was unproven, and
 * it no longer is -- every stored visit carries it -- but leaving it out meant a
 * webhook replaced the stored visit with one that had no Details, and synced a
 * benefit-package visit without the phrase that makes it an occupied inspection.
 */
export const VISIT_BY_ID_QUERY = visitsByIdsQuery(1);

/**
 * Up to 25 visits by id, for the sweep's look at linked visits its window did
 * not return (see `JobberSyncWorker.reconcileUnseen`). The same selection as
 * the single-visit query, at the page size the paged sync already pays for.
 */
export const VISITS_BY_IDS_QUERY = visitsByIdsQuery(25);

function visitsByIdsQuery(first: number) {
  return `
  query InspectionVisitById($ids: [EncodedId!]) {
    visits(first: ${first}, filter: { ids: $ids }) {
      nodes {
        id
        title
        ${VISIT_DETAILS_FIELD}
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
}

/**
 * An invoice, as the console's copy needs it: every detail Jobber keeps
 * (2026-11-05: "make sure we get everything, every details"), ahead of the
 * cutover, after which the console keeps them itself.
 *
 * Every field name here was read from Jobber's own schema by introspection on
 * the pinned version (2025-01-20) and checked against real invoices; an
 * unknown name fails the whole query. Nothing is selected that
 * `toInvoiceCopy` does not use.
 *
 * `Invoice.paymentRecords` returns Jobber's PaymentRecord object, which says
 * which payments the invoice has but not how each was paid. That lives on
 * Jobber's payment list (`PAYMENTS_PAGE_QUERY`), whose ids differ, so the two
 * are paired by invoice, day and amount.
 *
 * Notes and files are capped like lines and payments; an invoice with more is
 * read again by itself.
 */
function invoiceSelection(lines: number, payments: number, notes: number, files: number) {
  return `
        id
        invoiceNumber
        subject
        invoiceStatus
        issuedDate
        dueDate
        receivedDate
        dateViewedInClientHub
        message
        contractDisclaimer
        jobberWebUri
        updatedAt
        billingIsSameAsPropertyAddress
        taxCalculationMethod
        amounts {
          subtotal
          discountAmount
          taxAmount
          depositAmount
          tipsTotal
          total
          invoiceBalance
        }
        discount {
          rate
          type
        }
        taxRate {
          name
          tax
        }
        salesperson {
          name {
            full
          }
        }
        customFields {
          __typename
          ... on CustomFieldText {
            label
            valueText
          }
          ... on CustomFieldNumeric {
            label
            valueNumeric
            unit
          }
          ... on CustomFieldDropdown {
            label
            valueDropdown
          }
          ... on CustomFieldTrueFalse {
            label
            valueTrueFalse
          }
          ... on CustomFieldArea {
            label
          }
          ... on CustomFieldLink {
            label
          }
        }
        billingAddress {
          name
          street1
          street2
          city
          province
          postalCode
        }
        client {
          id
          name
          emails {
            address
            primary
          }
          phones {
            number
            primary
          }
        }
        jobs(first: 2) {
          nodes {
            id
            jobNumber
            title
          }
        }
        visits(first: 5) {
          nodes {
            id
          }
        }
        properties(first: 2) {
          nodes {
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
        lineItems(first: ${lines}) {
          totalCount
          nodes {
            name
            description
            quantity
            unitPrice
            totalPrice
            taxable
            date
            category
            linkedProductOrService {
              name
            }
          }
        }
        paymentRecords(first: ${payments}) {
          totalCount
          nodes {
            id
            amount
            entryDate
            adjustmentType
          }
        }
        notes(first: ${notes}) {
          totalCount
          nodes {
            __typename
            ... on InvoiceNote {
              id
              message
              pinned
              createdAt
            }
            ... on JobNote {
              id
              message
              pinned
              createdAt
            }
          }
        }
        noteAttachments(first: ${files}) {
          totalCount
          nodes {
            id
            fileName
            contentType
            fileSize
            url
            createdAt
          }
        }`;
}

/** Lines, payments, notes and files asked for on a page; an invoice with more is read again by itself. */
export const INVOICE_PAGE_LINES = 10;
export const INVOICE_PAGE_PAYMENTS = 10;
export const INVOICE_PAGE_NOTES = 5;
export const INVOICE_PAGE_FILES = 5;

/**
 * A page of invoices, oldest first.
 *
 * Two orders, one query. The first read pages every invoice by when it was
 * created, so an invoice edited while the read is under way cannot move behind
 * the cursor. After that, only what changed: updated after the last one
 * applied, oldest change first, so a run cut short resumes where it stopped.
 */
export const invoicesPageQuery = (mode: 'all' | 'changed') => `
  query ConsoleInvoices($first: Int!, $after: String${mode === 'changed' ? ', $updatedAfter: ISO8601DateTime' : ''}) {
    invoices(
      first: $first
      after: $after
      sort: [{ key: ${mode === 'all' ? 'CREATED_AT' : 'UPDATED_AT'}, direction: ASCENDING }]
      ${mode === 'changed' ? 'filter: { updatedAt: { after: $updatedAfter } }' : ''}
    ) {
      nodes {${invoiceSelection(INVOICE_PAGE_LINES, INVOICE_PAGE_PAYMENTS, INVOICE_PAGE_NOTES, INVOICE_PAGE_FILES)}
      }
      pageInfo {
        hasNextPage
        endCursor
      }
    }
  }
`;

/**
 * One invoice with all of its lines, payments, notes and files: for a webhook,
 * and for an invoice a page cut short. Null when Jobber no longer has it.
 */
export const INVOICE_BY_ID_QUERY = `
  query ConsoleInvoice($id: EncodedId!) {
    invoice(id: $id) {${invoiceSelection(100, 100, 50, 50)}
    }
  }
`;

/**
 * One payment as Jobber's payment list has it (2026-11-05): how it was paid,
 * its reference and its details -- what the invoice's own view of a payment
 * leaves out. Every name checked against the schema and real payments, which
 * are all ACH bank payments naming their invoice.
 */
const PAYMENT_RECORD_SELECTION = `
        id
        amount
        entryDate
        paymentType
        details
        invoice {
          id
        }
        ... on CheckPaymentRecord {
          checkNumber
        }
        ... on OtherPaymentRecord {
          confirmationNumber
        }
        ... on BankTransferPaymentRecord {
          confirmationNumber
        }
        ... on AchBankPaymentPaymentRecord {
          confirmationNumber
        }
        ... on CreditCardPaymentRecord {
          ccTransactionNumber
        }`;

/**
 * Jobber's payment list, payments only, in the order they were recorded. Read
 * once from the start, then from the kept cursor, which is where any payment
 * recorded since appears.
 */
export const PAYMENTS_PAGE_QUERY = `
  query ConsolePayments($first: Int!, $after: String) {
    paymentRecords(
      first: $first
      after: $after
      filter: { adjustmentType: PAYMENT }
      sort: { key: CREATED_AT, direction: ASCENDING }
    ) {
      nodes {${PAYMENT_RECORD_SELECTION}
      }
      pageInfo {
        hasNextPage
        endCursor
      }
    }
  }
`;

/**
 * One payment from Jobber's payment list, for a PAYMENT_* webhook: the invoice
 * it is on, which is read again, and how it was paid, which is paired with it.
 */
export const PAYMENT_RECORD_QUERY = `
  query ConsolePayment($id: EncodedId!) {
    paymentRecord(id: $id) {${PAYMENT_RECORD_SELECTION}
    }
  }
`;

/**
 * The files on one invoice, with fresh addresses to download them at
 * (2026-11-06, phase 7): Jobber's file links are not ones to keep, so the
 * console asks for them right before it copies each file into its own
 * storage. Ids, addresses and types only -- a few points. Both addresses and
 * both types: an iPhone photo's `url` and `contentType` are a JPEG conversion
 * the console cannot open, and `downloadUrl` and `downloadContentType` are the
 * original.
 */
export const INVOICE_FILES_QUERY = `
  query ConsoleInvoiceFiles($id: EncodedId!) {
    invoice(id: $id) {
      id
      noteAttachments(first: 100) {
        nodes {
          id
          contentType
          fileSize
          url
          downloadUrl
          downloadContentType
        }
      }
    }
  }
`;
