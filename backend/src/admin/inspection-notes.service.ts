import { Inject, Injectable } from '@nestjs/common';
import type { Prisma } from '@prisma/client';
import {
  MAX_OFFICE_NOTE,
  OFFICE_NOTE_PERMISSIONS,
  type OfficeNote,
  type OfficeNoteInput,
} from '@texasrenters/shared';

import { auditActor, isMachinePrincipal, type AuthenticatedUser } from '../common/auth';
import { ApplicationError } from '../common/errors';
import { PrismaService } from '../common/prisma.service';

/** What a note is read as, by the job and by the calls here. */
export const OFFICE_NOTE_SELECT = {
  id: true,
  text: true,
  visibleToTechnician: true,
  createdAt: true,
  editedAt: true,
  createdBy: { select: { id: true, displayName: true } },
} satisfies Prisma.InspectionNoteSelect;

type NoteRow = Prisma.InspectionNoteGetPayload<{ select: typeof OFFICE_NOTE_SELECT }>;

export function officeNoteView(row: NoteRow): OfficeNote {
  return {
    id: row.id,
    text: row.text,
    visibleToTechnician: row.visibleToTechnician,
    createdAt: row.createdAt.toISOString(),
    editedAt: row.editedAt?.toISOString() ?? null,
    author: row.createdBy,
  };
}

/**
 * What the office writes on a job (2026-11-07): "office can also make their own
 * internal notes".
 *
 * - **Any time.** A note is not evidence, so a submitted or finalized job takes
 *   one: that is when the office has most to say.
 * - **Anyone who can manage or review inspections** may write one, which the
 *   guard cannot say (it requires all it is given), so `mayWrite` does.
 * - **Only its author** may change or delete it.
 * - **Every change is on the job's history**, the old words with it. A delete
 *   removes the row, so the history is where its text survives.
 * - **Private until ticked.** Only a note with `visibleToTechnician` reaches the
 *   phone (`technicianJobNotes`). Nothing here reaches a report or Jobber.
 */
@Injectable()
export class InspectionNotesService {
  constructor(@Inject(PrismaService) private readonly prisma: PrismaService) {}

  async add(user: AuthenticatedUser, inspectionId: string, input: OfficeNoteInput): Promise<OfficeNote> {
    this.mayWrite(user);
    const text = this.written(input.text);
    return this.prisma.$transaction(async (tx) => {
      const inspection = await tx.inspection.findFirst({
        where: { id: inspectionId, organizationId: user.organizationId },
        select: { id: true },
      });
      if (!inspection)
        throw new ApplicationError(404, 'INSPECTION_NOT_FOUND', 'Inspection was not found.');
      const note = await tx.inspectionNote.create({
        data: {
          organizationId: user.organizationId,
          inspectionId,
          text,
          visibleToTechnician: input.visibleToTechnician,
          createdById: user.id,
        },
        select: OFFICE_NOTE_SELECT,
      });
      await this.audit(tx, user, 'INSPECTION_NOTE_ADDED', inspectionId, {
        noteId: note.id,
        text,
        visibleToTechnician: input.visibleToTechnician,
      });
      return officeNoteView(note);
    });
  }

  async edit(
    user: AuthenticatedUser,
    inspectionId: string,
    noteId: string,
    input: OfficeNoteInput,
  ): Promise<OfficeNote> {
    this.mayWrite(user);
    const text = this.written(input.text);
    return this.prisma.$transaction(async (tx) => {
      const before = await this.ownNote(tx, user, inspectionId, noteId);
      // Saved as it was: nothing changed, so it must not read "edited".
      if (before.text === text && before.visibleToTechnician === input.visibleToTechnician)
        return officeNoteView(before);
      const note = await tx.inspectionNote.update({
        where: { id: noteId },
        data: { text, visibleToTechnician: input.visibleToTechnician, editedAt: new Date() },
        select: OFFICE_NOTE_SELECT,
      });
      await this.audit(tx, user, 'INSPECTION_NOTE_EDITED', inspectionId, {
        noteId,
        before: { text: before.text, visibleToTechnician: before.visibleToTechnician },
        after: { text, visibleToTechnician: input.visibleToTechnician },
      });
      return officeNoteView(note);
    });
  }

  async remove(user: AuthenticatedUser, inspectionId: string, noteId: string) {
    this.mayWrite(user);
    return this.prisma.$transaction(async (tx) => {
      const note = await this.ownNote(tx, user, inspectionId, noteId);
      await tx.inspectionNote.delete({ where: { id: noteId } });
      await this.audit(tx, user, 'INSPECTION_NOTE_DELETED', inspectionId, {
        noteId,
        text: note.text,
        visibleToTechnician: note.visibleToTechnician,
      });
      return { deleted: true };
    });
  }

  /** A note is somebody's, and an integration is nobody to answer for it. */
  private mayWrite(user: AuthenticatedUser) {
    if (
      isMachinePrincipal(user) ||
      !OFFICE_NOTE_PERMISSIONS.some((permission) => user.permissions.includes(permission))
    )
      throw new ApplicationError(
        403,
        'NOTE_NOT_PERMITTED',
        'Only someone who can manage or review inspections can write notes on a job.',
      );
  }

  private written(text: string) {
    const written = text.trim();
    if (!written) throw new ApplicationError(400, 'NOTE_EMPTY', 'Write something in the note first.');
    if (written.length > MAX_OFFICE_NOTE)
      throw new ApplicationError(400, 'NOTE_TOO_LONG', `A note holds ${MAX_OFFICE_NOTE} characters at most.`);
    return written;
  }

  /** Scoped by job and organization, so an id from elsewhere cannot be reached through this route. */
  private async ownNote(
    tx: Prisma.TransactionClient,
    user: AuthenticatedUser,
    inspectionId: string,
    noteId: string,
  ) {
    const note = await tx.inspectionNote.findFirst({
      where: { id: noteId, inspectionId, organizationId: user.organizationId },
      select: OFFICE_NOTE_SELECT,
    });
    if (!note) throw new ApplicationError(404, 'NOTE_NOT_FOUND', 'That note was not found on this job.');
    if (note.createdBy?.id !== user.id)
      throw new ApplicationError(403, 'NOTE_NOT_YOURS', 'Only the person who wrote a note can change it.');
    return note;
  }

  private audit(
    tx: Prisma.TransactionClient,
    user: AuthenticatedUser,
    action: string,
    inspectionId: string,
    metadata: Prisma.InputJsonObject,
  ) {
    return tx.auditLog.create({
      data: {
        organizationId: user.organizationId,
        ...auditActor(user),
        action,
        entityType: 'Inspection',
        entityId: inspectionId,
        metadata,
      },
    });
  }
}
