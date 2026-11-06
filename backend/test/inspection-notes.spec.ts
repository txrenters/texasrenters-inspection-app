import { UserRole } from '@texasrenters/shared';

import { InspectionNotesService, OFFICE_NOTE_SELECT } from '../src/admin/inspection-notes.service';
import type { AuthenticatedUser } from '../src/common/auth';

/**
 * What the office writes on a job (2026-11-07): anyone who can manage or review
 * inspections writes, only the author changes, and every change keeps the old
 * words on the job's history. Ids and names invented.
 */

const ORG = '30000000-0000-4000-8000-000000000001';
const JOB = '30000000-0000-4000-8000-000000000010';
const NOTE = '30000000-0000-4000-8000-000000000020';
const ME = '30000000-0000-4000-8000-000000000030';
const SOMEBODY_ELSE = '30000000-0000-4000-8000-000000000031';

const person = (permissions: string[], over: Partial<AuthenticatedUser> = {}): AuthenticatedUser => ({
  id: ME,
  authUserId: 'auth-me',
  organizationId: ORG,
  displayName: 'Ada Lane',
  roles: [UserRole.PROPERTY_ADMIN],
  permissions: permissions as AuthenticatedUser['permissions'],
  mustChangePassword: false,
  principalType: 'USER',
  ...over,
});

const manager = person(['inspections:manage']);

const row = (over: Record<string, unknown> = {}) => ({
  id: NOTE,
  text: 'Owner called.',
  visibleToTechnician: false,
  createdAt: new Date('2026-11-06T15:00:00.000Z'),
  editedAt: null,
  createdBy: { id: ME, displayName: 'Ada Lane' },
  ...over,
});

function harness(existing: ReturnType<typeof row> | null = row()) {
  const tx = {
    inspection: { findFirst: jest.fn().mockResolvedValue({ id: JOB }) },
    inspectionNote: {
      create: jest.fn(async ({ data }) => row({ text: data.text, visibleToTechnician: data.visibleToTechnician })),
      findFirst: jest.fn().mockResolvedValue(existing),
      update: jest.fn(async ({ data }) => row(data)),
      delete: jest.fn().mockResolvedValue({}),
    },
    auditLog: { create: jest.fn().mockResolvedValue({}) },
  };
  const prisma = { $transaction: jest.fn(async (run: (client: typeof tx) => unknown) => run(tx)) };
  return { tx, service: new InspectionNotesService(prisma as never) };
}

const input = { text: 'Owner called.', visibleToTechnician: false };
const audited = (tx: ReturnType<typeof harness>['tx']) => tx.auditLog.create.mock.calls[0]?.[0].data;

describe('adding an office note', () => {
  it('records who wrote it, private unless ticked, on the job and its history', async () => {
    const { tx, service } = harness();

    const note = await service.add(manager, JOB, { text: '  Owner called.  ', visibleToTechnician: false });

    expect(tx.inspectionNote.create.mock.calls[0][0].data).toEqual({
      organizationId: ORG,
      inspectionId: JOB,
      text: 'Owner called.',
      visibleToTechnician: false,
      createdById: ME,
    });
    expect(note).toEqual({
      id: NOTE,
      text: 'Owner called.',
      visibleToTechnician: false,
      createdAt: '2026-11-06T15:00:00.000Z',
      editedAt: null,
      author: { id: ME, displayName: 'Ada Lane' },
    });
    expect(audited(tx)).toMatchObject({
      organizationId: ORG,
      actorUserId: ME,
      action: 'INSPECTION_NOTE_ADDED',
      entityType: 'Inspection',
      entityId: JOB,
      metadata: { noteId: NOTE, text: 'Owner called.', visibleToTechnician: false },
    });
  });

  it('takes either grant: managing inspections or reviewing them', async () => {
    await expect(harness().service.add(person(['inspections:manage']), JOB, input)).resolves.toBeTruthy();
    await expect(harness().service.add(person(['findings:review']), JOB, input)).resolves.toBeTruthy();
  });

  it('refuses somebody who can only read the job', async () => {
    const { tx, service } = harness();
    await expect(service.add(person(['inspections:read']), JOB, input)).rejects.toMatchObject({
      code: 'NOTE_NOT_PERMITTED',
    });
    expect(tx.inspectionNote.create).not.toHaveBeenCalled();
  });

  it('refuses an integration: a note is somebody\'s, and its id is no person\'s', async () => {
    const machine = person(['inspections:manage'], { principalType: 'API_KEY', apiClientId: ME });
    await expect(harness().service.add(machine, JOB, input)).rejects.toMatchObject({ code: 'NOTE_NOT_PERMITTED' });
  });

  it('refuses a note that is only spaces, or too long', async () => {
    const { service } = harness();
    await expect(service.add(manager, JOB, { ...input, text: '   ' })).rejects.toMatchObject({ code: 'NOTE_EMPTY' });
    await expect(service.add(manager, JOB, { ...input, text: 'x'.repeat(2001) })).rejects.toMatchObject({
      code: 'NOTE_TOO_LONG',
    });
  });

  it('takes 2,000 characters with spaces around them', async () => {
    const { tx, service } = harness();
    await service.add(manager, JOB, { ...input, text: `  ${'x'.repeat(2000)}  ` });
    expect(tx.inspectionNote.create.mock.calls[0][0].data.text).toHaveLength(2000);
  });

  it("will not write on another organization's job", async () => {
    const { tx, service } = harness();
    tx.inspection.findFirst.mockResolvedValue(null);

    await expect(service.add(manager, JOB, input)).rejects.toMatchObject({ code: 'INSPECTION_NOT_FOUND' });

    expect(tx.inspection.findFirst.mock.calls[0][0].where).toEqual({ id: JOB, organizationId: ORG });
    expect(tx.inspectionNote.create).not.toHaveBeenCalled();
  });

  it('asks nothing about the state of the job: a finished one takes a note', async () => {
    const { tx, service } = harness();
    await service.add(manager, JOB, input);
    expect(tx.inspection.findFirst.mock.calls[0][0].select).toEqual({ id: true });
  });
});

describe('editing an office note', () => {
  const changed = { text: 'Owner called twice.', visibleToTechnician: true };

  it('saves the change, marks it edited, and keeps the old words on the history', async () => {
    const { tx, service } = harness();

    const note = await service.edit(manager, JOB, NOTE, changed);

    expect(tx.inspectionNote.update.mock.calls[0][0]).toMatchObject({
      where: { id: NOTE },
      data: { text: 'Owner called twice.', visibleToTechnician: true, editedAt: expect.any(Date) },
    });
    expect(note.editedAt).toEqual(expect.any(String));
    expect(audited(tx)).toMatchObject({
      action: 'INSPECTION_NOTE_EDITED',
      entityId: JOB,
      metadata: {
        noteId: NOTE,
        before: { text: 'Owner called.', visibleToTechnician: false },
        after: { text: 'Owner called twice.', visibleToTechnician: true },
      },
    });
  });

  it('records a change of who can read it alone', async () => {
    const { tx, service } = harness();
    await service.edit(manager, JOB, NOTE, { ...input, visibleToTechnician: true });
    expect(tx.inspectionNote.update).toHaveBeenCalled();
    expect(audited(tx).action).toBe('INSPECTION_NOTE_EDITED');
  });

  it('changes nothing, and does not read "edited", when saved as it was', async () => {
    const { tx, service } = harness();
    const note = await service.edit(manager, JOB, NOTE, input);
    expect(tx.inspectionNote.update).not.toHaveBeenCalled();
    expect(tx.auditLog.create).not.toHaveBeenCalled();
    expect(note.editedAt).toBeNull();
  });

  it("refuses somebody else's note, whatever they may do", async () => {
    const { tx, service } = harness(row({ createdBy: { id: SOMEBODY_ELSE, displayName: 'Pat Example' } }));
    const everything = person(['inspections:manage', 'findings:review', 'inspections:finalize']);

    await expect(service.edit(everything, JOB, NOTE, changed)).rejects.toMatchObject({ code: 'NOTE_NOT_YOURS' });

    expect(tx.inspectionNote.update).not.toHaveBeenCalled();
  });

  it('refuses a note whose author has left: nobody owns it', async () => {
    const { service } = harness(row({ createdBy: null }));
    await expect(service.edit(manager, JOB, NOTE, changed)).rejects.toMatchObject({ code: 'NOTE_NOT_YOURS' });
  });

  it('reaches a note only through its own job and organization', async () => {
    const { tx, service } = harness(null);

    await expect(service.edit(manager, JOB, NOTE, changed)).rejects.toMatchObject({ code: 'NOTE_NOT_FOUND' });

    expect(tx.inspectionNote.findFirst.mock.calls[0][0].where).toEqual({
      id: NOTE,
      inspectionId: JOB,
      organizationId: ORG,
    });
  });

  it('refuses a person who has lost the grant, even on their own note', async () => {
    await expect(harness().service.edit(person(['inspections:read']), JOB, NOTE, changed)).rejects.toMatchObject({
      code: 'NOTE_NOT_PERMITTED',
    });
  });
});

describe('deleting an office note', () => {
  it('removes it, and the history keeps what it said', async () => {
    const { tx, service } = harness(row({ visibleToTechnician: true }));

    await expect(service.remove(manager, JOB, NOTE)).resolves.toEqual({ deleted: true });

    expect(tx.inspectionNote.delete).toHaveBeenCalledWith({ where: { id: NOTE } });
    expect(audited(tx)).toMatchObject({
      action: 'INSPECTION_NOTE_DELETED',
      entityId: JOB,
      metadata: { noteId: NOTE, text: 'Owner called.', visibleToTechnician: true },
    });
  });

  it("refuses somebody else's note", async () => {
    const { tx, service } = harness(row({ createdBy: { id: SOMEBODY_ELSE, displayName: 'Pat Example' } }));

    await expect(service.remove(manager, JOB, NOTE)).rejects.toMatchObject({ code: 'NOTE_NOT_YOURS' });

    expect(tx.inspectionNote.delete).not.toHaveBeenCalled();
    expect(tx.auditLog.create).not.toHaveBeenCalled();
  });
});

describe('what a note is read as', () => {
  it('names its author and nothing else about them', () => {
    expect(OFFICE_NOTE_SELECT.createdBy).toEqual({ select: { id: true, displayName: true } });
  });
});
