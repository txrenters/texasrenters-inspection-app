import { createHash } from 'node:crypto';

import { Inject, Injectable } from '@nestjs/common';
import {
  labourOf,
  MAX_PROJECT_ESTIMATE_CENTS,
  projectsAreOn,
  xeroCanMakeProjects,
  XERO_PROJECT_KIND,
  XERO_PROJECT_NAME_MAX,
  xeroProjectName,
  type MakeXeroProjectInput,
  type XeroProjectFailure,
  type XeroProjectOption,
  type XeroProjectVisit,
  type XeroSettingsValues,
  type XeroVisitCompanyProjects,
  type XeroVisitProjects,
} from '@texasrenters/shared';
import { InvoiceOrigin, InvoiceStatus, type Prisma } from '@prisma/client';
import { z } from 'zod';

import type { AuthenticatedUser } from '../../common/auth';
import { businessDate } from '../../common/business-day';
import { PrismaService } from '../../common/prisma.service';
import { TBP_TITLE_MARKER } from '../../planning/tbp-plan.service';
import { CALLS_KEPT_FOR_SENDING } from './xero-books.service';
import { xeroContacts } from './xero-contacts';
import { getXeroConfig } from './xero.config';
import { XeroClient } from './xero.client';
import { XeroError } from './xero.errors';
import { clientKeyOf, contactNameOf } from './xero-invoice';

/** Visits given a project in one run: four calls each at most, so a run stays well inside Xero's 60 a minute. */
export const MAX_PROJECTS_PER_RUN = 10;
/** Xero refused it: tried again after an hour, six, then daily. */
const BACKOFF_MS = [60, 360, 1440].map((minutes) => minutes * 60_000);
/** About one project; anything else -- the daily ceiling, the sign-in, Xero away or asking to slow down -- stops the run. */
const ABOUT_ONE = new Set(['XERO_VALIDATION', 'XERO_UNEXPECTED_RESPONSE']);
/** The labour's task on each project the console makes: what the office's expense was called. */
export const LABOUR_TASK_NAME = 'Hourly Labor Charge';
/** A company's projects in progress are read from Xero again six hours after the last full read (2026-11-13). */
export const PROJECTS_READ_EVERY_MS = 6 * 60 * 60_000;
/** Xero's largest page of projects. */
const PROJECTS_PAGE_SIZE = 500;
/** Pages of projects in one read: 2,000 projects in progress. THMP had about 700 (2026-11-11). */
export const MAX_PROJECT_PAGES_PER_READ = 4;
/** The projects a visit's company offers on the invoice form: the latest deadlines first. */
const MAX_PROJECTS_OFFERED = 50;

const amountSchema = z.object({ value: z.number().nullish() }).nullish();
const projectSchema = z.object({
  projectId: z.string(),
  name: z.string().nullish(),
  contactId: z.string().nullish(),
  status: z.string().nullish(),
  deadlineUtc: z.string().nullish(),
  estimate: amountSchema,
});
const projectsSchema = z.object({
  pagination: z.object({ page: z.number().nullish(), pageCount: z.number().nullish() }).nullish(),
  items: z.array(projectSchema).nullish(),
});
type Listed = z.infer<typeof projectSchema>;
const taskSchema = z.object({ taskId: z.string(), name: z.string().nullish() });
const tasksSchema = z.object({ items: z.array(taskSchema).nullish() });
const timeSchema = z.object({ timeEntryId: z.string() });
const timesSchema = z.object({ items: z.array(timeSchema).nullish() });

const keyOf = (scope: string, path: string, body: unknown) => createHash('sha256').update(`${scope}|${path}|${JSON.stringify(body)}`).digest('hex');
/** Names compared as the office types them: case and runs of spaces aside. */
const sameName = (a: string, b: string) => a.trim().replace(/\s+/g, ' ').toLowerCase() === b.trim().replace(/\s+/g, ' ').toLowerCase();
const DAY = /^\d{4}-\d{2}-\d{2}$/;
const isDay = (value: string) => DAY.test(value) && new Date(`${value}T00:00:00.000Z`).toISOString().slice(0, 10) === value;
const dayOf = (value: Date | null) => value?.toISOString().slice(0, 10) ?? null;

/** What a visit's project is named after, and when it is due. */
const INSPECTION_FIELDS = {
  id: true,
  scheduledAt: true,
  completedAt: true,
  inspectionType: true,
  jobberVisitTitle: true,
  tbpPlanStop: { select: { plan: { select: { quarterYear: true, quarterNumber: true } } } },
  assignments: { where: { isCurrent: true }, orderBy: { assignedAt: 'asc' }, take: 1, select: { technician: { select: { displayName: true } } } },
} satisfies Prisma.InspectionSelect;
type ProjectInspection = Prisma.InspectionGetPayload<{ select: typeof INSPECTION_FIELDS }>;

const VISIT_FIELDS = {
  id: true,
  clientName: true,
  jobberClientId: true,
  // The console's own goes under its property's contact (2026-11-12): its project too.
  origin: true,
  propertywareBuildingId: true,
  // The project a line of it names (2026-11-13, PR B): the visit's, with no project made for it.
  lines: { where: { xeroProjectId: { not: null } }, orderBy: { position: 'asc' }, take: 1, select: { xeroProjectId: true } },
  inspection: { select: INSPECTION_FIELDS },
} satisfies Prisma.InvoiceSelect;
type ProjectCandidate = Prisma.InvoiceGetPayload<{ select: typeof VISIT_FIELDS }>;

const PROJECT_FIELDS = { xeroProjectId: true, name: true, deadlineOn: true, status: true, madeHere: true } satisfies Prisma.XeroProjectSelect;
type ProjectRow = Prisma.XeroProjectGetPayload<{ select: typeof PROJECT_FIELDS }>;
const optionOf = (row: ProjectRow): XeroProjectOption => ({
  xeroProjectId: row.xeroProjectId,
  name: row.name,
  deadlineOn: dayOf(row.deadlineOn),
  status: row.status === 'CLOSED' ? 'CLOSED' : 'INPROGRESS',
  madeHere: row.madeHere,
});

/**
 * The benefit-package quarter a visit belongs to, as `visitQuarter` decides
 * it: its plan's; else, for one the office booked in Jobber itself, the
 * quarter its package title names; else, a package title naming none, the
 * quarter its day falls in. Null for any visit that is not a package one.
 */
export function packageQuarterOf(inspection: Pick<ProjectInspection, 'scheduledAt' | 'jobberVisitTitle' | 'tbpPlanStop'>): { year: number; quarter: number } | null {
  if (inspection.tbpPlanStop) return { year: inspection.tbpPlanStop.plan.quarterYear, quarter: inspection.tbpPlanStop.plan.quarterNumber };
  const title = inspection.jobberVisitTitle ?? '';
  if (!title.toLowerCase().includes(TBP_TITLE_MARKER)) return null;
  const named = /\bQ([1-4])\s+(\d{4})\b/i.exec(title);
  if (named) return { year: Number(named[2]), quarter: Number(named[1]) };
  return { year: inspection.scheduledAt.getUTCFullYear(), quarter: Math.floor(inspection.scheduledAt.getUTCMonth() / 3) + 1 };
}

/** The day a visit was finished, in Texas (2026-11-13); its scheduled day (that day's UTC midnight) while it has none. */
export const finishedDayOf = (inspection: Pick<ProjectInspection, 'completedAt' | 'scheduledAt'>) =>
  inspection.completedAt ? businessDate(inspection.completedAt) : inspection.scheduledAt.toISOString().slice(0, 10);

/** What a visit's project is named after: the day it was finished, its technician, and what it was. */
export function projectVisitOf(inspection: ProjectInspection): XeroProjectVisit {
  return {
    day: finishedDayOf(inspection),
    technicianName: inspection.assignments[0]?.technician.displayName ?? null,
    packageQuarter: packageQuarterOf(inspection),
    kind: XERO_PROJECT_KIND[inspection.inspectionType],
  };
}

/** A property's contact key: the one its console invoices go under (`clientKeyOf`). */
const propertyClient = (buildingId: string, clientName: string) => ({
  key: clientKeyOf({ jobberClientId: null, clientName, origin: InvoiceOrigin.CONSOLE, propertywareBuildingId: buildingId }),
  name: contactNameOf({ clientName }),
});

export interface XeroProjectsResult {
  /** Made in Xero by the console. */
  made: number;
  /** Found already made, by the office, under the same name: linked, given no labour. */
  linked: number;
  failed: number;
  /** The projects made or linked, for the run's audit entry. */
  names: string[];
}

/** One read of a company's projects in progress (2026-11-13). */
export interface XeroProjectsReadResult {
  read: number;
  /** In progress here, no longer in progress in Xero. */
  closed: number;
  calls: number;
  /** Every page was read: what is not in it is no longer in progress. */
  complete: boolean;
  problem: string | null;
}

/** What is known of a visit's project so far: kept on a refusal, so the next try carries on from it. */
interface Progress {
  name: string;
  xeroProjectId: string | null;
  madeHere: boolean;
  xeroTaskId: string | null;
  xeroTimeEntryId: string | null;
}

/**
 * A Xero project for each visit (2026-11-11), as the office keeps one in a
 * company's books: under the property's contact, named "Moses: Tenant Benefit
 * Package - 4th Qtr - 2026 - 11.10.2026", due on the day the visit was
 * finished, with the technician's labour logged on it as time -- an "Hourly
 * Labor Charge" task and six minutes on it, the $3.50 the office has been
 * adding by hand.
 *
 * Made first (2026-11-13), as the office makes one before the visit's invoice:
 * the New project dialog makes it in Xero at once and chooses it for the visit,
 * or the office chooses one already there. A visit with neither is given one
 * once its invoice is in Xero, so the contact is there. One the office made by
 * hand under the same name is linked and given no labour. Each step's id is
 * kept, so a refusal half-way is taken up where it stopped. Xero's API cannot
 * put an invoice line on a project: the office does that on the draft.
 *
 * The company's projects in progress are kept here -- read from Xero every six
 * hours while projects are on -- so the invoice form offers them with no call to
 * Xero.
 */
@Injectable()
export class XeroProjectsService {
  constructor(
    @Inject(PrismaService) private readonly prisma: PrismaService,
    @Inject(XeroClient) private readonly client: XeroClient,
  ) {}

  /** `result` is filled as it goes, so what was made before a stop is still counted. */
  async run(
    organizationId: string,
    tenantId: string,
    sendFrom: string,
    values: XeroSettingsValues,
    currency: string,
    result: XeroProjectsResult = { made: 0, linked: 0, failed: 0, names: [] },
  ): Promise<XeroProjectsResult> {
    const now = new Date();
    const invoices = await this.prisma.invoice.findMany({
      where: {
        organizationId,
        xeroTenantId: tenantId,
        // The console's sends only: an invoice read from Xero (2026-11-12) is the office's there, project and all.
        origin: { not: InvoiceOrigin.XERO },
        issuedOn: { gte: new Date(`${sendFrom}T00:00:00.000Z`) },
        // Once its invoice is in Xero, whatever its state there (2026-11-12): the console's own go as drafts.
        status: { not: InvoiceStatus.VOIDED },
        xeroSync: { is: { xeroTenantId: tenantId, status: 'SENT' } },
        // A visit with its project, or one refused and not due again yet, is left alone. One made or chosen first whose
        // labour is still to log (PENDING) is taken up.
        inspection: { is: { xeroProjectLinks: { none: { xeroTenantId: tenantId, OR: [{ status: 'DONE' }, { nextAttemptAt: { gt: now } }] } } } },
      },
      orderBy: [{ issuedOn: 'asc' }, { id: 'asc' }],
      take: MAX_PROJECTS_PER_RUN * 2,
      select: VISIT_FIELDS,
    });
    // One project a visit, however many of its invoices there are.
    const visits = new Map<string, ProjectCandidate & { inspection: ProjectInspection }>();
    for (const invoice of invoices)
      if (invoice.inspection && !visits.has(invoice.inspection.id)) visits.set(invoice.inspection.id, invoice as ProjectCandidate & { inspection: ProjectInspection });
    const due = [...visits.values()].slice(0, MAX_PROJECTS_PER_RUN);
    if (!due.length) return result;

    const [links, contacts] = await Promise.all([
      this.prisma.xeroProjectLink.findMany({ where: { organizationId, xeroTenantId: tenantId, inspectionId: { in: due.map((visit) => visit.inspection.id) } } }),
      this.prisma.xeroContactLink.findMany({
        where: { organizationId, xeroTenantId: tenantId, clientKey: { in: due.map((visit) => clientKeyOf(visit)) } },
        select: { clientKey: true, xeroContactId: true },
      }),
    ]);
    const linkOf = new Map(links.map((link) => [link.inspectionId, link]));
    const contactOf = new Map(contacts.map((contact) => [contact.clientKey, contact.xeroContactId]));
    const labour = labourOf(values);
    // The projects the invoices' lines name (2026-11-13, PR B), by their names here.
    const onLines = [...new Set(due.flatMap((visit) => (visit.lines[0]?.xeroProjectId ? [visit.lines[0].xeroProjectId] : [])))];
    const lineNames = new Map(
      (onLines.length
        ? await this.prisma.xeroProject.findMany({
            where: { organizationId, xeroTenantId: tenantId, xeroProjectId: { in: onLines } },
            select: { xeroProjectId: true, name: true },
          })
        : []
      ).map((row) => [row.xeroProjectId, row.name]),
    );

    for (const visit of due) {
      const inspectionId = visit.inspection.id;
      const before = linkOf.get(inspectionId) ?? null;
      const named = projectVisitOf(visit.inspection);
      const name = xeroProjectName(named);
      // A project the invoice's line names is the visit's: none is made for it.
      const onLine = before?.xeroProjectId ? null : (visit.lines[0]?.xeroProjectId ?? null);
      const progress: Progress = {
        // A project made or chosen first keeps the name it has.
        name: (before?.xeroProjectId ? before.name : onLine ? (lineNames.get(onLine) ?? name) : name) ?? before?.name ?? 'Unnamed visit',
        xeroProjectId: before?.xeroProjectId ?? onLine,
        madeHere: before?.madeHere ?? false,
        xeroTaskId: before?.xeroTaskId ?? null,
        xeroTimeEntryId: before?.xeroTimeEntryId ?? null,
      };
      const contactId = contactOf.get(clientKeyOf(visit));
      // Labour is logged only on a project the console makes, or made.
      const logsLabour = labour !== null && (!progress.xeroProjectId || progress.madeHere);
      const held =
        !progress.xeroProjectId && !name
          ? 'The visit has no technician, so its project cannot be named as the office names them. Assign one, then try again.'
          : !progress.xeroProjectId && !contactId
            ? 'Its client has no contact in Xero yet.'
            : logsLabour && !values.projectUserId
              ? 'Choose the Xero user the labour is logged under.'
              : null;
      if (held) {
        await this.failed(organizationId, tenantId, inspectionId, progress, before?.attempts ?? 0, held);
        result.failed++;
        continue;
      }
      try {
        const scope = `${organizationId}:${tenantId}:${inspectionId}`;
        if (!progress.xeroProjectId) {
          // One the office made by hand is the project: never a second under the same name.
          const theirs = await this.client.projectsGet(organizationId, tenantId, `/Projects?contactID=${encodeURIComponent(contactId!)}&pageSize=500`, projectsSchema);
          await this.keep(organizationId, tenantId, theirs.items ?? [], new Date());
          const found = (theirs.items ?? []).find((project) => sameName(project.name ?? '', name!));
          if (found) {
            progress.xeroProjectId = found.projectId;
            progress.madeHere = false;
          } else {
            const body = { contactId, name, deadlineUtc: `${named.day}T12:00:00Z` };
            const made = await this.client.projectsPost(organizationId, tenantId, '/Projects', body, projectSchema, keyOf(scope, '/Projects', body));
            progress.xeroProjectId = made.projectId;
            progress.madeHere = true;
            await this.keep(organizationId, tenantId, [{ projectId: made.projectId, name: name!, contactId: contactId!, status: 'INPROGRESS', deadlineUtc: body.deadlineUtc }], new Date(), true);
          }
        }
        // The labour, on the console's own projects only: one the office made may already carry its expense.
        if (progress.madeHere && labour) await this.logLabour(organizationId, tenantId, scope, progress, (before?.attempts ?? 0) > 0, values, currency, labour, named.day);
        await this.done(organizationId, tenantId, inspectionId, progress);
        if (progress.madeHere) result.made++;
        else result.linked++;
        result.names.push(progress.name);
      } catch (error) {
        const problem = error instanceof XeroError ? error.message : 'The project could not be made.';
        await this.failed(organizationId, tenantId, inspectionId, progress, before?.attempts ?? 0, problem);
        result.failed++;
        if (!(error instanceof XeroError) || !ABOUT_ONE.has(error.code)) throw error;
      }
    }
    return result;
  }

  /**
   * A finished visit's projects for the invoice form (2026-11-13): for each
   * company whose projects are on, the visit's project and those in progress
   * under the property's contact; and what a new one starts as. Or (PR B) a
   * property's, for its invoice no visit covers: those in progress under its
   * contact. From the console's own rows: no call to Xero.
   */
  async projectsFor(user: AuthenticatedUser, target: { inspectionId?: string; propertyId?: string }): Promise<XeroVisitProjects> {
    const { organizationId } = user;
    const place = await this.place(organizationId, target);
    const inspectionId = place.inspection?.id ?? null;
    const [companies, connection] = await Promise.all([
      this.prisma.xeroSettings.findMany({
        where: { organizationId, projectsEnabled: true, xeroOrganisation: { status: 'CONNECTED' } },
        orderBy: { xeroOrganisation: { name: 'asc' } },
        select: { xeroTenantId: true, projectsReadAt: true, xeroOrganisation: { select: { name: true } } },
      }),
      this.prisma.xeroConnection.findUnique({ where: { organizationId }, select: { status: true, scopes: true } }),
    ]);
    const tenants = companies.map((company) => company.xeroTenantId);
    const [contacts, links] = tenants.length
      ? await Promise.all([
          this.prisma.xeroContactLink.findMany({
            where: { organizationId, xeroTenantId: { in: tenants }, clientKey: place.client.key },
            select: { xeroTenantId: true, xeroContactId: true },
          }),
          inspectionId
            ? this.prisma.xeroProjectLink.findMany({
                where: { organizationId, xeroTenantId: { in: tenants }, inspectionId, xeroProjectId: { not: null } },
                select: { xeroTenantId: true, xeroProjectId: true, name: true, madeHere: true },
              })
            : [],
        ])
      : [[], []];
    const problem = connectionProblem(connection);
    const rows: XeroVisitCompanyProjects[] = await Promise.all(
      companies.map(async (company): Promise<XeroVisitCompanyProjects> => {
        const tenantId = company.xeroTenantId;
        const contactId = contacts.find((contact) => contact.xeroTenantId === tenantId)?.xeroContactId ?? null;
        const link = links.find((each) => each.xeroTenantId === tenantId) ?? null;
        const [projects, chosen] = await Promise.all([
          contactId
            ? this.prisma.xeroProject.findMany({
                where: { organizationId, xeroTenantId: tenantId, xeroContactId: contactId, status: 'INPROGRESS' },
                orderBy: [{ deadlineOn: { sort: 'desc', nulls: 'last' } }, { createdAt: 'desc' }],
                take: MAX_PROJECTS_OFFERED,
                select: PROJECT_FIELDS,
              })
            : [],
          link
            ? this.prisma.xeroProject.findUnique({
                where: { organizationId_xeroTenantId_xeroProjectId: { organizationId, xeroTenantId: tenantId, xeroProjectId: link.xeroProjectId! } },
                select: PROJECT_FIELDS,
              })
            : null,
        ]);
        return {
          tenantId,
          name: company.xeroOrganisation.name,
          // A link from before the projects were kept here (2026-11-11) still names its project.
          chosen: link ? (chosen ? optionOf(chosen) : { xeroProjectId: link.xeroProjectId!, name: link.name, deadlineOn: null, status: 'INPROGRESS', madeHere: link.madeHere }) : null,
          projects: projects.map(optionOf),
          problem,
          readAt: company.projectsReadAt?.toISOString() ?? null,
        };
      }),
    );
    return {
      inspectionId,
      propertyId: place.buildingId,
      contactName: place.client.name,
      suggestedName: place.inspection ? xeroProjectName(projectVisitOf(place.inspection)) : null,
      deadlineOn: place.inspection ? finishedDayOf(place.inspection) : businessDate(),
      companies: rows,
    };
  }

  /**
   * "Create project" (2026-11-13): the visit's project made in the company's
   * books at once, In progress, under the property's contact -- made a contact
   * first when the property has none there yet -- and chosen for the visit. One
   * already in progress there under the same name is chosen instead: never a
   * second. A resend of the same dialog answers with what the first made.
   *
   * Two calls to Xero when the property is already a contact: its projects, and
   * the new one; one or two more to make the contact.
   */
  async make(user: AuthenticatedUser, tenantId: string, input: MakeXeroProjectInput): Promise<{ project: XeroProjectOption; found: boolean }> {
    const { organizationId } = user;
    const name = input.name.trim().replace(/\s+/g, ' ');
    if (!name || name.length > XERO_PROJECT_NAME_MAX)
      throw new XeroError(`Give the project a name of up to ${XERO_PROJECT_NAME_MAX} characters.`, 'XERO_PROJECT_NAME_INVALID', 422);
    if (!isDay(input.deadlineOn)) throw new XeroError('Give the project a deadline.', 'XERO_PROJECT_DEADLINE_INVALID', 422);
    const estimateCents = input.estimateCents ?? null;
    if (estimateCents !== null && (!Number.isInteger(estimateCents) || estimateCents < 0 || estimateCents > MAX_PROJECT_ESTIMATE_CENTS))
      throw new XeroError('The estimate is not an amount Xero takes.', 'XERO_PROJECT_ESTIMATE_INVALID', 422);

    const prior = await this.prisma.xeroProject.findUnique({
      where: { organizationId_clientRequestId: { organizationId, clientRequestId: input.clientRequestId } },
      select: { ...PROJECT_FIELDS, xeroTenantId: true },
    });
    if (prior) {
      if (prior.xeroTenantId !== tenantId) throw new XeroError('That request was already used for another company’s project.', 'IDEMPOTENCY_KEY_REUSED', 409);
      return { project: optionOf(prior), found: false };
    }

    const place = await this.place(organizationId, input);
    const settings = await this.projectsOn(organizationId, tenantId, true);
    const contacts = await xeroContacts(this.prisma, this.client, organizationId, tenantId, new Map([[place.client.key, place.client.name]]));
    const contact = contacts.get(place.client.key);
    if (!contact || 'problem' in contact) throw new XeroError(contact?.problem ?? 'The property could not be made a contact in Xero.', 'XERO_PROJECT_CONTACT', 422);

    // What is in progress under the contact now, kept here -- the office's made by hand among them.
    const now = new Date();
    const theirs = await this.client.projectsGet(
      organizationId,
      tenantId,
      `/Projects?contactID=${encodeURIComponent(contact.id)}&states=INPROGRESS&pageSize=${PROJECTS_PAGE_SIZE}`,
      projectsSchema,
    );
    await this.keep(organizationId, tenantId, theirs.items ?? [], now);
    const same = (theirs.items ?? []).find((project) => sameName(project.name ?? '', name));
    let xeroProjectId: string;
    if (same) xeroProjectId = same.projectId;
    else {
      const body = {
        contactId: contact.id,
        name,
        deadlineUtc: `${input.deadlineOn}T12:00:00Z`,
        ...(estimateCents !== null ? { estimateAmount: Number((estimateCents / 100).toFixed(2)) } : {}),
      };
      const made = await this.client.projectsPost(
        organizationId,
        tenantId,
        '/Projects',
        body,
        projectSchema,
        keyOf(`${organizationId}:${tenantId}:${input.clientRequestId}`, '/Projects', body),
      );
      xeroProjectId = made.projectId;
    }
    const fields = { xeroContactId: contact.id, name, status: 'INPROGRESS', deadlineOn: new Date(`${input.deadlineOn}T00:00:00.000Z`), estimateCents, seenAt: now };
    const made = { madeHere: true, madeByUserId: user.id, clientRequestId: input.clientRequestId };
    const row = await this.prisma.xeroProject.upsert({
      where: { organizationId_xeroTenantId_xeroProjectId: { organizationId, xeroTenantId: tenantId, xeroProjectId } },
      create: { organizationId, xeroTenantId: tenantId, xeroProjectId, ...fields, ...(same ? {} : made) },
      update: same ? { seenAt: now } : { ...fields, ...made },
      select: PROJECT_FIELDS,
    });
    // A visit's (a property's is only kept): its labour, when the office logs any, is the next sending run's once the
    // invoice is in Xero.
    if (place.inspection) {
      const labourToLog = !same && labourOf(settings) !== null;
      await this.linkVisit(organizationId, tenantId, place.inspection.id, { xeroProjectId, name: row.name, madeHere: !same }, labourToLog ? 'PENDING' : 'DONE');
    }
    await this.prisma.auditLog.create({
      data: {
        organizationId,
        actorUserId: user.id,
        action: same ? 'XERO_PROJECT_CHOSEN' : 'XERO_PROJECT_MADE',
        entityType: place.inspection ? 'Inspection' : 'PropertywareBuilding',
        entityId: place.inspection?.id ?? place.buildingId,
        metadata: { tenantId, xeroProjectId, name: row.name, deadlineOn: input.deadlineOn, estimateCents, foundSameName: Boolean(same) },
      },
    });
    return { project: optionOf(row), found: Boolean(same) };
  }

  /**
   * A project already in the company's books chosen as the visit's (2026-11-13):
   * one in progress under the property's contact. Nothing is asked of Xero.
   */
  async choose(user: AuthenticatedUser, tenantId: string, inspectionId: string, xeroProjectId: string): Promise<XeroProjectOption> {
    const { organizationId } = user;
    const visit = await this.visit(organizationId, inspectionId);
    await this.projectsOn(organizationId, tenantId, false);
    const [project, contact, link] = await Promise.all([
      this.prisma.xeroProject.findUnique({
        where: { organizationId_xeroTenantId_xeroProjectId: { organizationId, xeroTenantId: tenantId, xeroProjectId } },
        select: { ...PROJECT_FIELDS, xeroContactId: true },
      }),
      this.prisma.xeroContactLink.findUnique({
        where: { organizationId_xeroTenantId_clientKey: { organizationId, xeroTenantId: tenantId, clientKey: visit.client.key } },
        select: { xeroContactId: true },
      }),
      this.prisma.xeroProjectLink.findUnique({
        where: { organizationId_xeroTenantId_inspectionId: { organizationId, xeroTenantId: tenantId, inspectionId } },
        select: { xeroProjectId: true },
      }),
    ]);
    if (!project) throw new XeroError('That project is not in this company’s books.', 'XERO_PROJECT_NOT_FOUND', 404);
    if (link?.xeroProjectId === xeroProjectId) return optionOf(project);
    if (!contact || project.xeroContactId !== contact.xeroContactId)
      throw new XeroError(`That project is not under ${visit.client.name} in Xero.`, 'XERO_PROJECT_OTHER_CONTACT', 422);
    if (project.status !== 'INPROGRESS') throw new XeroError('That project is closed in Xero.', 'XERO_PROJECT_CLOSED', 409);
    await this.linkVisit(organizationId, tenantId, inspectionId, { xeroProjectId, name: project.name, madeHere: false }, 'DONE');
    await this.prisma.auditLog.create({
      data: {
        organizationId,
        actorUserId: user.id,
        action: 'XERO_PROJECT_CHOSEN',
        entityType: 'Inspection',
        entityId: inspectionId,
        metadata: { tenantId, xeroProjectId, name: project.name, replaced: link?.xeroProjectId ?? null },
      },
    });
    return optionOf(project);
  }

  /**
   * The company's projects in progress, read from Xero (2026-11-13) when six
   * hours have passed since the last full read and its projects are on: a page
   * of 500 a call, at most four, inside the day's share the read leaves to
   * sending. Once every page is read, one here that was not in them is closed.
   */
  async readIfDue(organizationId: string, tenantId: string, now: Date = new Date()): Promise<XeroProjectsReadResult | null> {
    const where = { organizationId_xeroTenantId: { organizationId, xeroTenantId: tenantId } };
    const [settings, organisation, connection] = await Promise.all([
      this.prisma.xeroSettings.findUnique({ where, select: { projectsEnabled: true, projectsReadAt: true } }),
      this.prisma.xeroOrganisation.findUnique({ where, select: { status: true, callsDay: true, callsUsed: true } }),
      this.prisma.xeroConnection.findUnique({ where: { organizationId }, select: { status: true, scopes: true } }),
    ]);
    if (!settings || !projectsAreOn(settings)) return null;
    if (settings.projectsReadAt && now.getTime() - settings.projectsReadAt.getTime() < PROJECTS_READ_EVERY_MS) return null;
    if (organisation?.status !== 'CONNECTED' || connectionProblem(connection)) return null;
    const result: XeroProjectsReadResult = { read: 0, closed: 0, calls: 0, complete: false, problem: null };
    const used = organisation.callsDay === businessDate(now) ? organisation.callsUsed : 0;
    let calls = Math.min(MAX_PROJECT_PAGES_PER_READ, getXeroConfig().dailyCallCeiling - CALLS_KEPT_FOR_SENDING - used);
    if (calls < 1) return { ...result, problem: `The console keeps its last ${CALLS_KEPT_FOR_SENDING} calls to Xero today for sending.` };
    for (let page = 1; calls > 0; page++) {
      const listed = await this.client.projectsGet(organizationId, tenantId, `/Projects?states=INPROGRESS&page=${page}&pageSize=${PROJECTS_PAGE_SIZE}`, projectsSchema);
      calls--;
      result.calls++;
      const items = listed.items ?? [];
      await this.keep(organizationId, tenantId, items, now);
      result.read += items.length;
      const pageCount = listed.pagination?.pageCount ?? (items.length < PROJECTS_PAGE_SIZE ? page : page + 1);
      if (!items.length || page >= pageCount) {
        result.complete = true;
        break;
      }
    }
    if (!result.complete) return result;
    // Not in progress in Xero any more -- closed or deleted there: no longer offered. One made since the read began was
    // seen after it.
    const closed = await this.prisma.xeroProject.updateMany({
      where: { organizationId, xeroTenantId: tenantId, status: 'INPROGRESS', OR: [{ seenAt: null }, { seenAt: { lt: now } }] },
      data: { status: 'CLOSED' },
    });
    result.closed = closed.count;
    await this.prisma.xeroSettings.update({ where, data: { projectsReadAt: now } });
    return result;
  }

  /** The page's counts and latest refusals: no call to Xero. */
  async summary(organizationId: string, tenantId: string): Promise<{ done: number; failed: number; failures: XeroProjectFailure[] }> {
    const [done, failed, failures] = await Promise.all([
      this.prisma.xeroProjectLink.count({ where: { organizationId, xeroTenantId: tenantId, status: 'DONE' } }),
      this.prisma.xeroProjectLink.count({ where: { organizationId, xeroTenantId: tenantId, status: 'FAILED' } }),
      this.prisma.xeroProjectLink.findMany({
        where: { organizationId, xeroTenantId: tenantId, status: 'FAILED' },
        orderBy: [{ lastAttemptAt: 'desc' }],
        take: 50,
        select: { inspectionId: true, name: true, problem: true, attempts: true, lastAttemptAt: true, nextAttemptAt: true },
      }),
    ]);
    return {
      done,
      failed,
      failures: failures.map((row) => ({
        inspectionId: row.inspectionId,
        name: row.name,
        problem: row.problem ?? 'Not made.',
        attempts: row.attempts,
        lastAttemptAt: row.lastAttemptAt?.toISOString() ?? null,
        nextAttemptAt: row.nextAttemptAt?.toISOString() ?? null,
      })),
    };
  }

  /** "Try again": every refused project is due now. */
  async retry(organizationId: string, tenantId: string): Promise<number> {
    const { count } = await this.prisma.xeroProjectLink.updateMany({
      where: { organizationId, xeroTenantId: tenantId, status: 'FAILED' },
      data: { nextAttemptAt: new Date() },
    });
    return count;
  }

  /** The visit a project is for, and its property's contact. */
  private async visit(organizationId: string, inspectionId: string) {
    const row = await this.prisma.inspection.findFirst({
      where: { id: inspectionId, organizationId },
      select: { ...INSPECTION_FIELDS, propertywareBuilding: { select: { id: true, name: true, addressLine1: true } } },
    });
    if (!row) throw new XeroError('That visit was not found.', 'INSPECTION_NOT_FOUND', 404);
    const building = row.propertywareBuilding;
    if (!building) throw new XeroError('This visit has no property, so its project would have no contact.', 'XERO_PROJECT_NO_PROPERTY', 422);
    return { inspection: row, buildingId: building.id, client: propertyClient(building.id, building.addressLine1 ?? building.name) };
  }

  /** A visit's place, or (2026-11-13, PR B) a property's for its invoice no visit covers: one of the two. */
  private async place(
    organizationId: string,
    target: { inspectionId?: string; propertyId?: string },
  ): Promise<{ inspection: ProjectInspection | null; buildingId: string; client: { key: string; name: string } }> {
    if (Boolean(target.inspectionId) === Boolean(target.propertyId))
      throw new XeroError('A project is for a visit or a property: one of the two.', 'XERO_PROJECT_TARGET_INVALID', 422);
    if (target.inspectionId) return this.visit(organizationId, target.inspectionId);
    const building = await this.prisma.propertywareBuilding.findFirst({
      where: { id: target.propertyId, organizationId },
      select: { id: true, name: true, addressLine1: true },
    });
    if (!building) throw new XeroError('That property was not found.', 'PROPERTY_NOT_FOUND', 404);
    return { inspection: null, buildingId: building.id, client: propertyClient(building.id, building.addressLine1 ?? building.name) };
  }

  /** The company's projects are on -- and, to make one, its books can be reached with the projects permission. */
  private async projectsOn(organizationId: string, tenantId: string, toXero: boolean) {
    const where = { organizationId_xeroTenantId: { organizationId, xeroTenantId: tenantId } };
    const [settings, organisation, connection] = await Promise.all([
      this.prisma.xeroSettings.findUnique({ where, select: { projectsEnabled: true, labourRateCents: true, labourMinutes: true } }),
      this.prisma.xeroOrganisation.findUnique({ where, select: { name: true, status: true } }),
      toXero ? this.prisma.xeroConnection.findUnique({ where: { organizationId }, select: { status: true, scopes: true } }) : null,
    ]);
    if (!organisation) throw new XeroError('That is not one of the office’s Xero organisations.', 'XERO_ORGANISATION_UNKNOWN', 404);
    if (!settings || !projectsAreOn(settings))
      throw new XeroError(`Projects are off for ${organisation.name}. Turn them on, on the Xero page, first.`, 'XERO_PROJECTS_OFF', 409);
    if (toXero) {
      const problem = organisation.status !== 'CONNECTED' ? `${organisation.name} is no longer connected to the console.` : connectionProblem(connection);
      if (problem) throw new XeroError(problem, 'XERO_PROJECTS_UNREACHABLE', 409);
    }
    return settings;
  }

  /** The visit's project in one company: made or chosen here; PENDING while the labour on one made here is still to log. */
  private linkVisit(
    organizationId: string,
    tenantId: string,
    inspectionId: string,
    project: { xeroProjectId: string; name: string; madeHere: boolean },
    status: 'DONE' | 'PENDING',
  ) {
    const now = new Date();
    const data = {
      ...project,
      // The labour logged on another project stays there.
      xeroTaskId: null,
      xeroTimeEntryId: null,
      status,
      attempts: 0,
      lastAttemptAt: now,
      nextAttemptAt: null,
      problem: null,
      doneAt: status === 'DONE' ? now : null,
    };
    return this.prisma.xeroProjectLink.upsert({
      where: { organizationId_xeroTenantId_inspectionId: { organizationId, xeroTenantId: tenantId, inspectionId } },
      create: { organizationId, xeroTenantId: tenantId, inspectionId, ...data },
      update: data,
    });
  }

  /**
   * Projects Xero listed, kept here: new ones added, changed ones updated, all
   * marked seen. `madeHere` for one the run just made.
   */
  private async keep(organizationId: string, tenantId: string, listed: Listed[], seenAt: Date, madeHere = false) {
    if (!listed.length) return;
    const fieldsOf = (project: Listed) => ({
      xeroContactId: project.contactId ?? null,
      name: project.name?.trim().slice(0, 255) || 'Unnamed project',
      status: project.status === 'CLOSED' ? 'CLOSED' : 'INPROGRESS',
      deadlineOn: project.deadlineUtc ? new Date(`${project.deadlineUtc.slice(0, 10)}T00:00:00.000Z`) : null,
    });
    const existing = await this.prisma.xeroProject.findMany({
      where: { organizationId, xeroTenantId: tenantId, xeroProjectId: { in: listed.map((project) => project.projectId) } },
      select: { id: true, xeroProjectId: true, xeroContactId: true, name: true, status: true, deadlineOn: true },
    });
    const known = new Map(existing.map((row) => [row.xeroProjectId, row]));
    const fresh = listed.filter((project) => !known.has(project.projectId));
    if (fresh.length)
      await this.prisma.xeroProject.createMany({
        data: fresh.map((project) => ({
          organizationId,
          xeroTenantId: tenantId,
          xeroProjectId: project.projectId,
          ...fieldsOf(project),
          estimateCents: project.estimate?.value != null ? Math.max(0, Math.round(project.estimate.value * 100)) : null,
          madeHere,
          seenAt,
        })),
        skipDuplicates: true,
      });
    for (const project of listed) {
      const row = known.get(project.projectId);
      if (!row) continue;
      const fields = fieldsOf(project);
      if (row.xeroContactId !== fields.xeroContactId || row.name !== fields.name || row.status !== fields.status || dayOf(row.deadlineOn) !== dayOf(fields.deadlineOn))
        await this.prisma.xeroProject.update({ where: { id: row.id }, data: fields });
    }
    if (known.size)
      await this.prisma.xeroProject.updateMany({ where: { organizationId, xeroTenantId: tenantId, xeroProjectId: { in: [...known.keys()] } }, data: { seenAt } });
  }

  /** The labour on a project the console made: its task, then the time on it, each looked for first on a retry. */
  private async logLabour(
    organizationId: string,
    tenantId: string,
    scope: string,
    progress: Progress,
    retrying: boolean,
    values: XeroSettingsValues,
    currency: string,
    labour: { rateCents: number; minutes: number },
    day: string,
  ) {
    const project = `/Projects/${encodeURIComponent(progress.xeroProjectId!)}`;
    if (!progress.xeroTaskId && retrying) {
      const tasks = await this.client.projectsGet(organizationId, tenantId, `${project}/Tasks?pageSize=500`, tasksSchema);
      progress.xeroTaskId = (tasks.items ?? []).find((task) => sameName(task.name ?? '', LABOUR_TASK_NAME))?.taskId ?? null;
    }
    if (!progress.xeroTaskId) {
      const body = { name: LABOUR_TASK_NAME, rate: { currency, value: labour.rateCents / 100 }, chargeType: 'TIME' };
      progress.xeroTaskId = (await this.client.projectsPost(organizationId, tenantId, `${project}/Tasks`, body, taskSchema, keyOf(scope, `${project}/Tasks`, body))).taskId;
    }
    if (!progress.xeroTimeEntryId && retrying) {
      const times = await this.client.projectsGet(organizationId, tenantId, `${project}/Time?taskId=${encodeURIComponent(progress.xeroTaskId)}`, timesSchema);
      progress.xeroTimeEntryId = times.items?.[0]?.timeEntryId ?? null;
    }
    if (!progress.xeroTimeEntryId) {
      const body = { userId: values.projectUserId, taskId: progress.xeroTaskId, dateUtc: `${day}T12:00:00Z`, duration: labour.minutes, description: `Visit on ${day}` };
      progress.xeroTimeEntryId = (await this.client.projectsPost(organizationId, tenantId, `${project}/Time`, body, timeSchema, keyOf(scope, `${project}/Time`, body))).timeEntryId;
    }
  }

  private done(organizationId: string, tenantId: string, inspectionId: string, progress: Progress) {
    const now = new Date();
    const data = { ...progress, status: 'DONE', lastAttemptAt: now, nextAttemptAt: null, problem: null, doneAt: now };
    return this.prisma.xeroProjectLink.upsert({
      where: { organizationId_xeroTenantId_inspectionId: { organizationId, xeroTenantId: tenantId, inspectionId } },
      create: { organizationId, xeroTenantId: tenantId, inspectionId, ...data },
      update: data,
    });
  }

  private failed(organizationId: string, tenantId: string, inspectionId: string, progress: Progress, attemptsBefore: number, problem: string) {
    const now = new Date();
    const attempts = attemptsBefore + 1;
    const data = {
      ...progress,
      status: 'FAILED',
      attempts,
      lastAttemptAt: now,
      nextAttemptAt: new Date(now.getTime() + BACKOFF_MS[Math.min(attempts, BACKOFF_MS.length) - 1]!),
      problem: problem.slice(0, 1000),
    };
    return this.prisma.xeroProjectLink.upsert({
      where: { organizationId_xeroTenantId_inspectionId: { organizationId, xeroTenantId: tenantId, inspectionId } },
      create: { organizationId, xeroTenantId: tenantId, inspectionId, ...data },
      update: data,
    });
  }
}

/** Why the console cannot reach the company's projects now; null when it can. */
function connectionProblem(connection: { status: string; scopes: string[] } | null): string | null {
  if (connection?.status !== 'CONNECTED') return 'Xero is not connected. Connect it again on the Xero page.';
  if (!xeroCanMakeProjects(connection.scopes)) return 'Connect again, so Xero lets the console make projects.';
  return null;
}
