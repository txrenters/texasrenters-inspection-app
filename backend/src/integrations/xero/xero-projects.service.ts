import { createHash } from 'node:crypto';

import { Inject, Injectable } from '@nestjs/common';
import { labourOf, xeroProjectName, type XeroProjectFailure, type XeroProjectVisit, type XeroSettingsValues } from '@texasrenters/shared';
import { InvoiceOrigin, InvoiceStatus, type Prisma } from '@prisma/client';
import { z } from 'zod';

import { PrismaService } from '../../common/prisma.service';
import { TBP_TITLE_MARKER } from '../../planning/tbp-plan.service';
import { XeroClient } from './xero.client';
import { XeroError } from './xero.errors';
import { clientKeyOf } from './xero-invoice';

/** Visits given a project in one run: four calls each at most, so a run stays well inside Xero's 60 a minute. */
export const MAX_PROJECTS_PER_RUN = 10;
/** Xero refused it: tried again after an hour, six, then daily. */
const BACKOFF_MS = [60, 360, 1440].map((minutes) => minutes * 60_000);
/** About one project; anything else -- the daily ceiling, the sign-in, Xero away or asking to slow down -- stops the run. */
const ABOUT_ONE = new Set(['XERO_VALIDATION', 'XERO_UNEXPECTED_RESPONSE']);
/** The labour's task on each project the console makes: what the office's expense was called. */
export const LABOUR_TASK_NAME = 'Hourly Labor Charge';

const projectSchema = z.object({ projectId: z.string(), name: z.string().nullish() });
const projectsSchema = z.object({ items: z.array(projectSchema).nullish() });
const taskSchema = z.object({ taskId: z.string(), name: z.string().nullish() });
const tasksSchema = z.object({ items: z.array(taskSchema).nullish() });
const timeSchema = z.object({ timeEntryId: z.string() });
const timesSchema = z.object({ items: z.array(timeSchema).nullish() });

const keyOf = (scope: string, path: string, body: unknown) => createHash('sha256').update(`${scope}|${path}|${JSON.stringify(body)}`).digest('hex');
/** Names compared as the office types them: case and runs of spaces aside. */
const sameName = (a: string, b: string) => a.trim().replace(/\s+/g, ' ').toLowerCase() === b.trim().replace(/\s+/g, ' ').toLowerCase();

const VISIT_FIELDS = {
  id: true,
  clientName: true,
  jobberClientId: true,
  // The console's own goes under its property's contact (2026-11-12): its project too.
  origin: true,
  propertywareBuildingId: true,
  lines: { orderBy: { position: 'asc' }, take: 1, select: { name: true } },
  inspection: {
    select: {
      id: true,
      scheduledAt: true,
      jobberVisitTitle: true,
      tbpPlanStop: { select: { plan: { select: { quarterYear: true, quarterNumber: true } } } },
      assignments: { where: { isCurrent: true }, orderBy: { assignedAt: 'asc' }, take: 1, select: { technician: { select: { displayName: true } } } },
    },
  },
} satisfies Prisma.InvoiceSelect;
type ProjectCandidate = Prisma.InvoiceGetPayload<{ select: typeof VISIT_FIELDS }>;
type Inspection = NonNullable<ProjectCandidate['inspection']>;

/**
 * The benefit-package quarter a visit belongs to, as `visitQuarter` decides
 * it: its plan's; else, for one the office booked in Jobber itself, the
 * quarter its package title names; else, a package title naming none, the
 * quarter its day falls in. Null for any visit that is not a package one.
 */
export function packageQuarterOf(inspection: Pick<Inspection, 'scheduledAt' | 'jobberVisitTitle' | 'tbpPlanStop'>): { year: number; quarter: number } | null {
  if (inspection.tbpPlanStop) return { year: inspection.tbpPlanStop.plan.quarterYear, quarter: inspection.tbpPlanStop.plan.quarterNumber };
  const title = inspection.jobberVisitTitle ?? '';
  if (!title.toLowerCase().includes(TBP_TITLE_MARKER)) return null;
  const named = /\bQ([1-4])\s+(\d{4})\b/i.exec(title);
  if (named) return { year: Number(named[2]), quarter: Number(named[1]) };
  return { year: inspection.scheduledAt.getUTCFullYear(), quarter: Math.floor(inspection.scheduledAt.getUTCMonth() / 3) + 1 };
}

/** What a visit's project is named after: its day (`scheduledAt` is that day's UTC midnight), technician, and kind. */
export function projectVisitOf(invoice: ProjectCandidate & { inspection: Inspection }): XeroProjectVisit {
  return {
    day: invoice.inspection.scheduledAt.toISOString().slice(0, 10),
    technicianName: invoice.inspection.assignments[0]?.technician.displayName ?? null,
    packageQuarter: packageQuarterOf(invoice.inspection),
    kind: invoice.lines[0]?.name ?? '',
  };
}

export interface XeroProjectsResult {
  /** Made in Xero by the console. */
  made: number;
  /** Found already made, by the office, under the same name: linked, given no labour. */
  linked: number;
  failed: number;
  /** The projects made or linked, for the run's audit entry. */
  names: string[];
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
 * Package - 4th Qtr - 2026 - 11.10.2026", due on the visit's day, with the
 * technician's labour logged on it as time -- an "Hourly Labor Charge" task and
 * six minutes on it, the $3.50 the office has been adding by hand.
 *
 * Only for invoices already in Xero, so the contact is there. One the office
 * made by hand under the same name is linked and given no labour. Each step's
 * id is kept, so a refusal half-way is taken up where it stopped. Xero's API
 * cannot put an invoice line on a project: the office does that on the draft.
 * At most ten visits a run, four calls each; nothing is asked of Xero when no
 * visit needs a project.
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
        // A visit with its project, or one refused and not due again yet, is left alone.
        inspection: { is: { xeroProjectLinks: { none: { xeroTenantId: tenantId, OR: [{ status: 'DONE' }, { nextAttemptAt: { gt: now } }] } } } },
      },
      orderBy: [{ issuedOn: 'asc' }, { id: 'asc' }],
      take: MAX_PROJECTS_PER_RUN * 2,
      select: VISIT_FIELDS,
    });
    // One project a visit, however many of its invoices there are.
    const visits = new Map<string, ProjectCandidate & { inspection: Inspection }>();
    for (const invoice of invoices) if (invoice.inspection && !visits.has(invoice.inspection.id)) visits.set(invoice.inspection.id, invoice as ProjectCandidate & { inspection: Inspection });
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

    for (const visit of due) {
      const inspectionId = visit.inspection.id;
      const before = linkOf.get(inspectionId) ?? null;
      const name = xeroProjectName(projectVisitOf(visit));
      const progress: Progress = {
        name: name ?? before?.name ?? 'Unnamed visit',
        xeroProjectId: before?.xeroProjectId ?? null,
        madeHere: before?.madeHere ?? false,
        xeroTaskId: before?.xeroTaskId ?? null,
        xeroTimeEntryId: before?.xeroTimeEntryId ?? null,
      };
      const contactId = contactOf.get(clientKeyOf(visit));
      const held = !name
        ? 'The visit has no technician, so its project cannot be named as the office names them. Assign one, then try again.'
        : !contactId
          ? 'Its client has no contact in Xero yet.'
          : labour && !values.projectUserId
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
          const found = (theirs.items ?? []).find((project) => sameName(project.name ?? '', name!));
          if (found) {
            progress.xeroProjectId = found.projectId;
            progress.madeHere = false;
          } else {
            const body = { contactId, name, deadlineUtc: `${projectVisitOf(visit).day}T12:00:00Z` };
            const made = await this.client.projectsPost(organizationId, tenantId, '/Projects', body, projectSchema, keyOf(scope, '/Projects', body));
            progress.xeroProjectId = made.projectId;
            progress.madeHere = true;
          }
        }
        // The labour, on the console's own projects only: one the office made may already carry its expense.
        if (progress.madeHere && labour) {
          const project = `/Projects/${encodeURIComponent(progress.xeroProjectId)}`;
          const retrying = (before?.attempts ?? 0) > 0;
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
            const day = projectVisitOf(visit).day;
            const body = { userId: values.projectUserId, taskId: progress.xeroTaskId, dateUtc: `${day}T12:00:00Z`, duration: labour.minutes, description: `Visit on ${day}` };
            progress.xeroTimeEntryId = (await this.client.projectsPost(organizationId, tenantId, `${project}/Time`, body, timeSchema, keyOf(scope, `${project}/Time`, body))).timeEntryId;
          }
        }
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
