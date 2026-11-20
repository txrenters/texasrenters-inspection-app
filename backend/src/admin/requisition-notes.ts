import type { Prisma } from '@prisma/client';
import { requisitionerCode, type RequisitionLink, type RequisitionNote } from '@texasrenters/shared';

import type { AuthenticatedUser } from '../common/auth';

/**
 * Notes, comments and links on a purchase requisition, as its detail reads
 * them (2026-11-20). Kept apart from the service that writes them so the
 * requisition can read them without importing that service.
 */

type Db = Prisma.TransactionClient;
const who = (person: { id: string; displayName: string }) => ({ id: person.id, name: person.displayName, code: requisitionerCode(person.displayName) });

/** A requisition's notes, comments and links, oldest first, with what the caller may take off. */
export async function requisitionNotesAndLinks(db: Pick<Db, 'purchaseRequisitionNote' | 'purchaseRequisitionLink'>, user: AuthenticatedUser, requisitionId: string) {
  const where = { organizationId: user.organizationId, requisitionId };
  const [written, links] = await Promise.all([
    db.purchaseRequisitionNote.findMany({ where, select: { id: true, kind: true, text: true, writtenAt: true, writtenBy: { select: { id: true, displayName: true } } }, orderBy: [{ writtenAt: 'asc' }, { id: 'asc' }] }),
    db.purchaseRequisitionLink.findMany({ where, select: { id: true, url: true, title: true, addedAt: true, addedBy: { select: { id: true, displayName: true } } }, orderBy: [{ addedAt: 'asc' }, { id: 'asc' }] }),
  ]);
  const shown = (row: (typeof written)[number]): RequisitionNote => ({
    id: row.id,
    text: row.text,
    by: who(row.writtenBy),
    at: row.writtenAt.toISOString(),
    canRemove: row.kind === 'NOTE' && row.writtenBy.id === user.id,
  });
  return {
    notes: written.filter((row) => row.kind === 'NOTE').map(shown),
    comments: written.filter((row) => row.kind === 'COMMENT').map(shown),
    links: links.map((row): RequisitionLink => ({ id: row.id, url: row.url, title: row.title, by: who(row.addedBy), at: row.addedAt.toISOString(), canRemove: row.addedBy.id === user.id })),
  };
}

