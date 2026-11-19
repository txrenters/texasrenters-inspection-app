import { Inject, Injectable } from '@nestjs/common';
import type { Prisma } from '@prisma/client';
import {
  REQUISITION_LINKS_MAX,
  REQUISITION_LINK_TITLE_MAX_LENGTH,
  REQUISITION_NOTES_MAX,
  REQUISITION_NOTE_MAX_LENGTH,
  requisitionLinkUrl,
  type AddRequisitionLinkInput,
  type AddRequisitionNoteInput,
  type RequisitionDetail,
} from '@texasrenters/shared';

import { auditActor, type AuthenticatedUser } from '../common/auth';
import { ApplicationError } from '../common/errors';
import { PrismaService } from '../common/prisma.service';
import { PurchasingService, visibleRequisitions } from './purchasing.service';

/**
 * Notes, comments and links on a purchase requisition (2026-11-20): the
 * ribbon's "Show Attached" group on the NAV-style requisition.
 *
 * - Anybody who sees a requisition writes a note, comments, or adds a link, at
 *   any stage: a comment on a rejected one is how somebody asks why.
 * - A note's writer takes it off, and a link's adder; a comment stays in the
 *   thread, so the conversation is never rewritten.
 * - A link is only ever an http(s) address (checked here and by the database).
 *
 * Every step is audited and shows in the requisition's history. Nothing
 * billed is called.
 */

type Db = Prisma.TransactionClient;
const ENTITY = 'PurchaseRequisition';

@Injectable()
export class RequisitionNotesService {
  constructor(
    @Inject(PrismaService) private readonly prisma: PrismaService,
    @Inject(PurchasingService) private readonly purchasing: PurchasingService,
  ) {}

  /** A note on the record, or a comment in its thread. */
  async write(user: AuthenticatedUser, requisitionId: string, kind: 'NOTE' | 'COMMENT', input: AddRequisitionNoteInput): Promise<RequisitionDetail> {
    const text = input.text.trim();
    if (!text) throw new ApplicationError(400, 'REQUISITION_NOTE_INVALID', kind === 'NOTE' ? 'Write the note first.' : 'Write the comment first.');
    if (text.length > REQUISITION_NOTE_MAX_LENGTH) throw new ApplicationError(400, 'REQUISITION_NOTE_INVALID', `Keep it under ${REQUISITION_NOTE_MAX_LENGTH} characters.`);
    await this.prisma.$transaction(async (tx) => {
      await this.seen(tx, user, requisitionId);
      // One at a time per requisition, so two written at once cannot pass the limit together.
      await tx.$queryRaw`SELECT pg_advisory_xact_lock(hashtextextended(${`requisition-notes:${requisitionId}`}, 0))::text AS locked`;
      if ((await tx.purchaseRequisitionNote.count({ where: { organizationId: user.organizationId, requisitionId } })) >= REQUISITION_NOTES_MAX)
        throw new ApplicationError(409, 'REQUISITION_NOTES_FULL', `A requisition holds at most ${REQUISITION_NOTES_MAX} notes and comments.`);
      const note = await tx.purchaseRequisitionNote.create({ data: { organizationId: user.organizationId, requisitionId, kind, text, writtenById: user.id }, select: { id: true } });
      await this.audit(tx, user, kind === 'NOTE' ? 'PURCHASE_REQUISITION_NOTE_ADDED' : 'PURCHASE_REQUISITION_COMMENTED', requisitionId, { noteId: note.id, note: text.slice(0, 200) });
    });
    return this.purchasing.detail(user, requisitionId);
  }

  /** A note comes off by its writer; a comment never does. */
  async removeNote(user: AuthenticatedUser, requisitionId: string, noteId: string): Promise<RequisitionDetail> {
    await this.prisma.$transaction(async (tx) => {
      await this.seen(tx, user, requisitionId);
      const note = await tx.purchaseRequisitionNote.findFirst({ where: { id: noteId, requisitionId, organizationId: user.organizationId }, select: { kind: true, text: true, writtenById: true } });
      if (!note) throw new ApplicationError(404, 'REQUISITION_NOTE_NOT_FOUND', 'That note is not on this requisition.');
      if (note.kind !== 'NOTE') throw new ApplicationError(409, 'REQUISITION_COMMENT_KEPT', 'A comment stays in the thread.');
      if (note.writtenById !== user.id) throw new ApplicationError(403, 'REQUISITION_NOTE_NOT_YOURS', 'Only whoever wrote a note takes it off.');
      await tx.purchaseRequisitionNote.deleteMany({ where: { id: noteId, organizationId: user.organizationId } });
      await this.audit(tx, user, 'PURCHASE_REQUISITION_NOTE_REMOVED', requisitionId, { noteId, note: note.text.slice(0, 200) });
    });
    return this.purchasing.detail(user, requisitionId);
  }

  async addLink(user: AuthenticatedUser, requisitionId: string, input: AddRequisitionLinkInput): Promise<RequisitionDetail> {
    const url = requisitionLinkUrl(input.url);
    if (!url) throw new ApplicationError(400, 'REQUISITION_LINK_INVALID', 'A link is a web address starting with https:// or http://.');
    const title = input.title.trim().replace(/\s+/g, ' ') || new URL(url).hostname;
    if (title.length > REQUISITION_LINK_TITLE_MAX_LENGTH) throw new ApplicationError(400, 'REQUISITION_LINK_INVALID', `Keep the title under ${REQUISITION_LINK_TITLE_MAX_LENGTH} characters.`);
    await this.prisma.$transaction(async (tx) => {
      await this.seen(tx, user, requisitionId);
      await tx.$queryRaw`SELECT pg_advisory_xact_lock(hashtextextended(${`requisition-links:${requisitionId}`}, 0))::text AS locked`;
      if ((await tx.purchaseRequisitionLink.count({ where: { organizationId: user.organizationId, requisitionId } })) >= REQUISITION_LINKS_MAX)
        throw new ApplicationError(409, 'REQUISITION_LINKS_FULL', `A requisition holds at most ${REQUISITION_LINKS_MAX} links. Take one off first.`);
      const link = await tx.purchaseRequisitionLink.create({ data: { organizationId: user.organizationId, requisitionId, url, title, addedById: user.id }, select: { id: true } });
      await this.audit(tx, user, 'PURCHASE_REQUISITION_LINK_ADDED', requisitionId, { linkId: link.id, note: title, url });
    });
    return this.purchasing.detail(user, requisitionId);
  }

  async removeLink(user: AuthenticatedUser, requisitionId: string, linkId: string): Promise<RequisitionDetail> {
    await this.prisma.$transaction(async (tx) => {
      await this.seen(tx, user, requisitionId);
      const link = await tx.purchaseRequisitionLink.findFirst({ where: { id: linkId, requisitionId, organizationId: user.organizationId }, select: { title: true, addedById: true } });
      if (!link) throw new ApplicationError(404, 'REQUISITION_LINK_NOT_FOUND', 'That link is not on this requisition.');
      if (link.addedById !== user.id) throw new ApplicationError(403, 'REQUISITION_LINK_NOT_YOURS', 'Only whoever added a link takes it off.');
      await tx.purchaseRequisitionLink.deleteMany({ where: { id: linkId, organizationId: user.organizationId } });
      await this.audit(tx, user, 'PURCHASE_REQUISITION_LINK_REMOVED', requisitionId, { linkId, note: link.title });
    });
    return this.purchasing.detail(user, requisitionId);
  }

  /** The requisition, if the caller sees it: somebody else's draft, or another office's, is simply not there. */
  private async seen(db: Db, user: AuthenticatedUser, requisitionId: string) {
    const requisition = await db.purchaseRequisition.findFirst({ where: { id: requisitionId, organizationId: user.organizationId, AND: [visibleRequisitions(user)] }, select: { id: true } });
    if (!requisition) throw new ApplicationError(404, 'REQUISITION_NOT_FOUND', 'That requisition is not on the list.');
  }

  private audit(db: Pick<Db, 'auditLog'>, user: AuthenticatedUser, action: string, requisitionId: string, metadata: Record<string, unknown>) {
    return db.auditLog.create({ data: { organizationId: user.organizationId, ...auditActor(user), action, entityType: ENTITY, entityId: requisitionId, metadata: metadata as never } });
  }
}
