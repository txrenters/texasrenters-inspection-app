import { Inject, Injectable, Logger } from '@nestjs/common';
import type { JobberVisitDetails } from '@texasrenters/shared';

import { businessDate } from '../../common/business-day';
import { ApplicationError } from '../../common/errors';
import { PrismaService } from '../../common/prisma.service';
import { withTenant } from '../../database/tenant-context';
import { JobberClient } from './jobber.client';

/** Read again from Jobber after this long; a second open within it is answered from the copy. */
const FRESH_MS = 5 * 60_000;
/** Most visits remembered at once, across every organization. */
const REMEMBERED = 500;
/** Most reads from Jobber a Texas day an organization, however often Details is opened. */
export const DAILY_CEILING = 600;

// Every field here is one the schema probe printed for Visit, Job and Client on
// the live account (2026-11-25), so the read cannot fail on a name Jobber lacks.
const DETAILS_QUERY = `
  query VisitDetails($ids: [EncodedId!]) {
    visits(first: 1, filter: { ids: $ids }) {
      nodes {
        id title instructions startAt allDay completedAt incompleteJobFormsCount
        job { jobNumber title jobberWebUri }
        client { name defaultPhones defaultEmails jobberWebUri }
        property { address { street1 street2 city province postalCode } }
        assignedUsers(first: 5) { nodes { name { full } } }
        notes(first: 10) {
          totalCount
          nodes { __typename ... on JobNote { message createdAt } ... on ClientNote { message createdAt } }
        }
      }
    }
  }`;

// JobLineItem's fields were not in the probe's output: read on their own, so a
// name Jobber does not have costs the line items and nothing else.
const LINE_ITEMS_QUERY = `
  query VisitLineItems($ids: [EncodedId!]) {
    visits(first: 1, filter: { ids: $ids }) {
      nodes { lineItems(first: 20) { nodes { name description quantity totalPrice } } }
    }
  }`;

type Strings = string | string[] | null | undefined;
interface DetailsNode {
  id: string;
  title?: string | null;
  instructions?: string | null;
  startAt?: string | null;
  allDay?: boolean | null;
  completedAt?: string | null;
  incompleteJobFormsCount?: number | null;
  job?: { jobNumber?: number | string | null; title?: string | null; jobberWebUri?: string | null } | null;
  client?: { name?: string | null; defaultPhones?: Strings; defaultEmails?: Strings; jobberWebUri?: string | null } | null;
  property?: {
    address?: { street1?: string | null; street2?: string | null; city?: string | null; province?: string | null; postalCode?: string | null } | null;
  } | null;
  assignedUsers?: { nodes: { name?: { full?: string | null } | null }[] } | null;
  notes?: { totalCount?: number | null; nodes: { message?: string | null; createdAt?: string | null }[] } | null;
}
interface LineItemsNode {
  lineItems?: {
    nodes: { name?: string | null; description?: string | null; quantity?: number | null; totalPrice?: number | null }[];
  } | null;
}

const list = (value: Strings) =>
  (Array.isArray(value) ? value : (value ?? '').split(','))
    .map((part) => part.trim())
    .filter(Boolean);

/**
 * One visit's "Visit details", read from Jobber when the office opens it
 * (2026-11-25: "when details is clicked a new modal will pop up like this").
 *
 * Read-only: nothing here writes to Jobber. One open is at most two Jobber
 * queries, the same visit opened again within five minutes is none, and an
 * organization reads no more than DAILY_CEILING a Texas day -- so a page left
 * open, or a click held down, cannot spend the account's rate limit.
 */
@Injectable()
export class JobberVisitDetailsService {
  private readonly logger = new Logger(JobberVisitDetailsService.name);
  private readonly remembered = new Map<string, { at: number; details: JobberVisitDetails }>();
  private readonly reads = new Map<string, { day: string; count: number }>();

  constructor(
    @Inject(PrismaService) private readonly prisma: PrismaService,
    @Inject(JobberClient) private readonly client: JobberClient,
  ) {}

  async details(organizationId: string, jobberVisitId: string, now = new Date()): Promise<JobberVisitDetails> {
    const key = `${organizationId}:${jobberVisitId}`;
    const copy = this.remembered.get(key);
    if (copy && now.getTime() - copy.at < FRESH_MS) return copy.details;

    // Only a visit the sync stored for this organization: an id from anywhere
    // else is not read from Jobber on its behalf.
    const stored = await withTenant(organizationId, () =>
      this.prisma.jobberVisitImport.findFirst({ where: { organizationId, jobberVisitId }, select: { id: true } }),
    );
    if (!stored) throw new ApplicationError(404, 'JOBBER_VISIT_NOT_FOUND', 'That visit is not one the sync has from Jobber.');

    const day = businessDate(now);
    const read = this.reads.get(organizationId);
    const count = read?.day === day ? read.count : 0;
    if (count >= DAILY_CEILING)
      throw new ApplicationError(429, 'JOBBER_DETAILS_CEILING', 'Visit details from Jobber are paused until tomorrow. Open the visit in Jobber.');
    this.reads.set(organizationId, { day, count: count + 1 });

    const ask = <T>(query: string) =>
      withTenant(organizationId, () => this.client.request<T>(organizationId, query, { ids: [jobberVisitId] }));
    const [main, lines] = await Promise.allSettled([
      ask<{ visits: { nodes: DetailsNode[] } }>(DETAILS_QUERY),
      ask<{ visits: { nodes: LineItemsNode[] } }>(LINE_ITEMS_QUERY),
    ]);
    if (main.status === 'rejected') throw main.reason;
    if (lines.status === 'rejected')
      this.logger.warn({ event: 'jobber_visit_line_items_failed', organizationId, message: String(lines.reason?.message ?? lines.reason) });

    const node = main.value.visits.nodes[0];
    if (!node) throw new ApplicationError(404, 'JOBBER_VISIT_NOT_FOUND', 'Jobber no longer has that visit.');
    const details = toDetails(node, lines.status === 'fulfilled' ? (lines.value.visits.nodes[0] ?? null) : undefined, now);

    if (this.remembered.size >= REMEMBERED) this.remembered.delete(this.remembered.keys().next().value!);
    this.remembered.set(key, { at: now.getTime(), details });
    return details;
  }
}

/** `lines` undefined when the line items could not be read; null when Jobber returned no visit for them. */
export function toDetails(node: DetailsNode, lines: LineItemsNode | null | undefined, now: Date): JobberVisitDetails {
  const address = node.property?.address;
  const region = [address?.province, address?.postalCode].map((part) => part?.trim()).filter(Boolean).join(' ');
  const cityLine = [address?.city?.trim(), region].filter(Boolean).join(', ');
  const jobNumber = node.job?.jobNumber;
  return {
    jobberVisitId: node.id,
    title: node.title ?? null,
    completed: Boolean(node.completedAt),
    startAt: node.startAt && !node.allDay ? new Date(node.startAt).toISOString() : null,
    date: node.startAt ? businessDate(new Date(node.startAt)) : null,
    addressLines: [address?.street1, address?.street2, cityLine].map((line) => line?.trim() ?? '').filter(Boolean),
    instructions: node.instructions?.trim() || null,
    job: node.job
      ? {
          number: jobNumber === null || jobNumber === undefined || jobNumber === '' ? null : String(jobNumber),
          title: node.job.title ?? null,
          url: node.job.jobberWebUri ?? null,
        }
      : null,
    team: (node.assignedUsers?.nodes ?? []).map((user) => user.name?.full?.trim() ?? '').filter(Boolean),
    client: node.client
      ? {
          name: node.client.name ?? null,
          phones: list(node.client.defaultPhones),
          emails: list(node.client.defaultEmails),
          url: node.client.jobberWebUri ?? null,
        }
      : null,
    notes: (node.notes?.nodes ?? [])
      .filter((note) => note.message?.trim())
      .map((note) => ({ message: note.message!.trim(), createdAt: note.createdAt ?? null })),
    notesTotal: node.notes?.totalCount ?? node.notes?.nodes.length ?? 0,
    checklistsToDo: node.incompleteJobFormsCount ?? null,
    lineItems:
      lines === undefined
        ? null
        : (lines?.lineItems?.nodes ?? []).map((item) => ({
            name: item.name ?? null,
            description: item.description?.trim() || null,
            quantity: item.quantity ?? null,
            totalPrice: item.totalPrice ?? null,
          })),
    readAt: now.toISOString(),
  };
}
