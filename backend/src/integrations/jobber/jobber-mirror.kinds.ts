import { JobberRecordKind } from '@prisma/client';

import { VISIT_DETAILS_FIELD } from './jobber.queries';

/**
 * Every kind of Jobber record the mirror copies, and what it asks for
 * (2026-11-24).
 *
 * Each selection is wider than the sync's: the point is to keep what the office
 * would otherwise lose when Jobber goes, not only what a screen shows today.
 * Jobber prices a page as `first` times the fields asked, nested lists
 * included, so nested lists are kept short on a page and a record that has
 * more is read again by itself (`isCutShort`) -- the way the invoice read
 * handles long invoices.
 */

export interface NestedLimits {
  notes: number;
  lines: number;
}

export const PAGE_LIMITS: NestedLimits = { notes: 5, lines: 20 };
export const ALONE_LIMITS: NestedLimits = { notes: 50, lines: 100 };

export interface MirrorKind {
  kind: JobberRecordKind;
  /** Root list, e.g. `jobs`. */
  connection: string;
  /** Root single-record field, for a record read by itself; null when Jobber has none worth using. */
  single: string | null;
  pageSize: number;
  /** How "what changed" is read: by update time, by a window of start dates, or not at all (walked daily). */
  changes: 'updatedAt' | 'startAtWindow' | null;
  /** Has `noteAttachments`. */
  hasFiles: boolean;
  select(limits: NestedLimits): string;
}

const ADDRESS = 'address { street1 street2 city province postalCode }';
const notes = (noteType: string, first: number) =>
  `notes(first: ${first}) { totalCount nodes { __typename ... on ${noteType} { id message createdAt } } }`;
const FILE_COUNT = 'noteAttachments(first: 1) { totalCount }';

export const MIRROR_KINDS: readonly MirrorKind[] = [
  {
    kind: JobberRecordKind.CLIENT,
    connection: 'clients',
    single: 'client',
    pageSize: 25,
    changes: 'updatedAt',
    hasFiles: true,
    select: (l) => `
      id name firstName lastName companyName isCompany isArchived createdAt updatedAt
      emails { address description primary }
      phones { number description primary }
      billingAddress { street1 street2 city province postalCode }
      ${notes('ClientNote', l.notes)} ${FILE_COUNT}`,
  },
  {
    kind: JobberRecordKind.PROPERTY,
    connection: 'properties',
    single: null,
    pageSize: 50,
    changes: null,
    hasFiles: false,
    select: () => `id ${ADDRESS} client { id name }`,
  },
  {
    kind: JobberRecordKind.JOB,
    connection: 'jobs',
    single: 'job',
    pageSize: 25,
    changes: 'updatedAt',
    hasFiles: true,
    select: (l) => `
      id jobNumber title instructions jobStatus jobType startAt endAt completedAt createdAt updatedAt total
      client { id name } property { id ${ADDRESS} }
      ${notes('JobNote', l.notes)} ${FILE_COUNT}`,
  },
  {
    kind: JobberRecordKind.VISIT,
    connection: 'visits',
    single: null,
    pageSize: 25,
    changes: 'startAtWindow',
    hasFiles: false,
    select: () => `
      id title ${VISIT_DETAILS_FIELD} startAt endAt completedAt createdAt visitStatus allDay
      job { id jobNumber } client { id name } property { id ${ADDRESS} }
      assignedUsers(first: 5) { nodes { id name { full } } }`,
  },
  {
    kind: JobberRecordKind.QUOTE,
    connection: 'quotes',
    single: 'quote',
    pageSize: 10,
    changes: 'updatedAt',
    hasFiles: true,
    select: (l) => `
      id quoteNumber title quoteStatus createdAt updatedAt
      amounts { subtotal total }
      client { id name } property { id ${ADDRESS} }
      lineItems(first: ${l.lines}) { totalCount nodes { name description quantity unitPrice totalPrice } }
      ${notes('QuoteNote', l.notes)} ${FILE_COUNT}`,
  },
  {
    kind: JobberRecordKind.REQUEST,
    connection: 'requests',
    single: 'request',
    pageSize: 25,
    changes: 'updatedAt',
    hasFiles: true,
    select: (l) => `
      id title requestStatus createdAt updatedAt
      client { id name } property { id ${ADDRESS} }
      ${notes('RequestNote', l.notes)} ${FILE_COUNT}`,
  },
];

export function mirrorKind(kind: JobberRecordKind): MirrorKind {
  const spec = MIRROR_KINDS.find((k) => k.kind === kind);
  if (!spec) throw new Error(`No mirror kind ${kind}.`);
  return spec;
}

const pascal = (value: string) => value[0]!.toUpperCase() + value.slice(1);

export function mirrorPageQuery(spec: MirrorKind, mode: 'walk' | 'changes'): string {
  const variables = ['$first: Int!', '$after: String'];
  let filter = '';
  if (mode === 'changes' && spec.changes === 'updatedAt') {
    variables.push('$since: ISO8601DateTime');
    filter = 'filter: { updatedAt: { after: $since } }';
  } else if (mode === 'changes' && spec.changes === 'startAtWindow') {
    variables.push('$from: ISO8601DateTime', '$to: ISO8601DateTime');
    filter = 'filter: { startAt: { after: $from, before: $to } }';
  }
  return `
  query Mirror${pascal(spec.connection)}(${variables.join(', ')}) {
    ${spec.connection}(first: $first, after: $after ${filter}) {
      nodes { ${spec.select(PAGE_LIMITS)} }
      pageInfo { hasNextPage endCursor }
    }
  }`;
}

export function mirrorOneQuery(spec: MirrorKind): string {
  if (!spec.single) throw new Error(`${spec.kind} is not read by itself.`);
  return `
  query MirrorOne${pascal(spec.single)}($id: EncodedId!) {
    ${spec.single}(id: $id) { ${spec.select(ALONE_LIMITS)} }
  }`;
}

/** The same attachment fields the invoice file copy reads, plus the name. */
export function mirrorFilesQuery(spec: MirrorKind): string {
  if (!spec.single || !spec.hasFiles) throw new Error(`${spec.kind} has no attachments to list.`);
  return `
  query MirrorFiles${pascal(spec.single)}($id: EncodedId!) {
    ${spec.single}(id: $id) {
      id
      noteAttachments(first: 100) {
        totalCount
        nodes { id fileName contentType fileSize url downloadUrl downloadContentType }
      }
    }
  }`;
}

export interface RecordSummary {
  number: string | null;
  title: string | null;
  clientJobberId: string | null;
  propertyJobberId: string | null;
  jobJobberId: string | null;
  address: string | null;
  occursAt: Date | null;
  status: string | null;
  jobberCreatedAt: Date | null;
  jobberUpdatedAt: Date | null;
  fileCount: number;
}

type Node = Record<string, unknown>;

const text = (value: unknown): string | null => {
  if (value === null || value === undefined || value === '') return null;
  if (typeof value === 'string') return value;
  if (typeof value === 'number') return String(value);
  throw new TypeError('Expected text.');
};

const date = (value: unknown): Date | null => {
  const raw = text(value);
  if (!raw) return null;
  const parsed = new Date(raw);
  if (Number.isNaN(parsed.getTime())) throw new TypeError(`Not a date: ${raw}`);
  return parsed;
};

const child = (node: Node, key: string): Node | null => {
  const value = node[key];
  if (value === null || value === undefined) return null;
  if (typeof value !== 'object' || Array.isArray(value)) throw new TypeError(`Expected ${key} to be an object.`);
  return value as Node;
};

const idOf = (node: Node | null) => (node ? text(node.id) : null);

const oneLine = (address: Node | null): string | null => {
  if (!address) return null;
  const street = [text(address.street1), text(address.street2)].filter(Boolean).join(' ');
  const region = [text(address.province), text(address.postalCode)].filter(Boolean).join(' ');
  return [street, text(address.city), region].filter(Boolean).join(', ') || null;
};

/** The columns a mirrored record is found by. Throws on a shape it cannot read; the caller keeps the payload anyway. */
export function summarize(kind: JobberRecordKind, node: Node): RecordSummary {
  const client = child(node, 'client');
  const property = child(node, 'property');
  const job = child(node, 'job');
  const createdAt = date(node.createdAt);
  const startAt = date(node.startAt);
  const files = child(node, 'noteAttachments');

  const byKind: Record<JobberRecordKind, () => Pick<RecordSummary, 'number' | 'title' | 'address' | 'status' | 'occursAt'>> = {
    CLIENT: () => ({
      number: null,
      title: text(node.name),
      address: oneLine(child(node, 'billingAddress')),
      status: node.isArchived === true ? 'archived' : 'active',
      occursAt: createdAt,
    }),
    PROPERTY: () => {
      const line = oneLine(child(node, 'address'));
      return { number: null, title: line, address: line, status: null, occursAt: null };
    },
    JOB: () => ({
      number: text(node.jobNumber),
      title: text(node.title),
      address: oneLine(property ? child(property, 'address') : null),
      status: text(node.jobStatus),
      occursAt: startAt ?? createdAt,
    }),
    VISIT: () => ({
      number: job ? text(job.jobNumber) : null,
      title: text(node.title),
      address: oneLine(property ? child(property, 'address') : null),
      status: text(node.visitStatus),
      occursAt: startAt ?? createdAt,
    }),
    QUOTE: () => ({
      number: text(node.quoteNumber),
      title: text(node.title),
      address: oneLine(property ? child(property, 'address') : null),
      status: text(node.quoteStatus),
      occursAt: createdAt,
    }),
    REQUEST: () => ({
      number: null,
      title: text(node.title),
      address: oneLine(property ? child(property, 'address') : null),
      status: text(node.requestStatus),
      occursAt: createdAt,
    }),
  };

  return {
    ...byKind[kind](),
    clientJobberId: idOf(client),
    propertyJobberId: kind === JobberRecordKind.PROPERTY ? null : idOf(property),
    jobJobberId: kind === JobberRecordKind.VISIT ? idOf(job) : null,
    jobberCreatedAt: createdAt,
    jobberUpdatedAt: date(node.updatedAt),
    fileCount: typeof files?.totalCount === 'number' ? files.totalCount : 0,
  };
}

/** A nested list on the record holds fewer items than Jobber says it has. */
export function isCutShort(node: Node): boolean {
  return Object.values(node).some((value) => {
    if (!value || typeof value !== 'object') return false;
    const list = value as { totalCount?: unknown; nodes?: unknown };
    return typeof list.totalCount === 'number' && Array.isArray(list.nodes) && list.totalCount > list.nodes.length;
  });
}
