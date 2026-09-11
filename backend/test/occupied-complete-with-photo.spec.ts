import 'reflect-metadata';

import { UserRole } from '@texasrenters/shared';

import type { AuthenticatedUser } from '../src/common/auth';
import { TechnicianService } from '../src/technician/technician.service';

/**
 * An occupied area can be finished with a photograph. The server has to agree.
 *
 * #148 taught the handset's completion gate that an occupied area needs a
 * photograph *or* a recording — an occupied inspection is a periodic look
 * around somebody's home, and requiring a video per room had technicians
 * filming empty hallways to get past a disabled button.
 *
 * `completeRoom` was never told. It went on demanding an uploaded video for
 * every inspection type, so the two disagreed in the worst possible direction:
 * Mark Complete looked enabled, and the request behind it answered
 * `409 ROOM_VIDEO_REQUIRED`. A technician has no way to read that as anything
 * but a broken app — and it lands at the end of the room, after the work.
 *
 * The rule now lives once, in `inspectionRequiresAreaRecording`. These tests
 * are the server half of it.
 */

const technician: AuthenticatedUser = {
  id: '10000000-0000-4000-8000-000000000004',
  authUserId: 'auth-technician',
  organizationId: '10000000-0000-4000-8000-000000000001',
  displayName: 'Field Technician',
  roles: [UserRole.INSPECTION_TECHNICIAN],
  permissions: [],
  mustChangePassword: false,
  principalType: 'USER',
};

const ROOM_ID = '20000000-0000-4000-8000-000000000001';

function build({
  inspectionType = 'OCCUPIED',
  media = [] as { uploadStatus: string }[],
  photos = 0,
} = {}) {
  const update = jest.fn().mockResolvedValue({
    id: ROOM_ID,
    inspectionId: 'inspection-1',
    completionStatus: 'COMPLETED',
    inspection: { inspectionType },
    propertyArea: { baselineConditions: [] },
    media,
  });
  const count = jest.fn().mockResolvedValue(photos);
  const prisma = {
    inspectionArea: {
      findFirst: jest.fn().mockResolvedValue({
        id: ROOM_ID,
        inspectionId: 'inspection-1',
        propertyAreaId: 'area-1',
        completionStatus: 'PENDING',
        inspection: { inspectionType },
        propertyArea: { baselineConditions: [] },
        media,
      }),
      update,
    },
    inspectionPhoto: { count },
  };
  const service = new TechnicianService(prisma as never, {} as never, {} as never, {
    // `mediaProcessing` is untouched by this path; a bare object keeps the
    // constructor happy without pretending the pipeline is involved.
  } as never);
  return { service, update, count };
}

const UPLOADED = [{ uploadStatus: 'UPLOADED' }];

describe('completing an occupied area', () => {
  it('accepts a photograph where there is no recording', async () => {
    const { service, update } = build({ photos: 3 });
    await service.completeRoom(technician, ROOM_ID);
    expect(update).toHaveBeenCalled();
    expect(update.mock.calls[0][0].data.completionStatus).toBe('COMPLETED');
  });

  it('accepts a recording, as it always did', async () => {
    const { service, update, count } = build({ media: UPLOADED });
    await service.completeRoom(technician, ROOM_ID);
    expect(update).toHaveBeenCalled();
    // Not queried when a recording already settles it — a move-out costs
    // exactly the round trips it did before this change.
    expect(count).not.toHaveBeenCalled();
  });

  it('still refuses an area with no evidence at all', async () => {
    // "Not obliged to film" is not "may finish having recorded nothing". An
    // area with neither is one nobody can show was inspected.
    const { service, update } = build({ photos: 0 });
    await expect(service.completeRoom(technician, ROOM_ID)).rejects.toMatchObject({
      status: 409,
      code: 'ROOM_EVIDENCE_REQUIRED',
    });
    expect(update).not.toHaveBeenCalled();
  });

  it('names the fix the technician can actually act on', async () => {
    // ROOM_VIDEO_REQUIRED would send them back to film. On an occupied area
    // they need a photograph, or an honest skip.
    const { service } = build({ photos: 0 });
    await expect(service.completeRoom(technician, ROOM_ID)).rejects.toMatchObject({
      message: expect.stringContaining('Photograph this room'),
    });
  });
});

describe('completing an area of every other kind of visit', () => {
  it.each([['MOVE_IN'], ['MOVE_OUT'], ['BACK_TO_MARKET'], ['HVAC']])(
    'still requires a recording on %s',
    async (inspectionType) => {
      // A move-in and a move-out are the condition record a comparison is built
      // from, and the walkthrough is the evidence. Photographs do not replace it.
      const { service, count } = build({ inspectionType, photos: 12 });
      await expect(service.completeRoom(technician, ROOM_ID)).rejects.toMatchObject({
        status: 409,
        code: 'ROOM_VIDEO_REQUIRED',
      });
      // Twelve photographs, and it does not even ask.
      expect(count).not.toHaveBeenCalled();
    },
  );

  it('accepts a recording on a move-out', async () => {
    const { service, update } = build({ inspectionType: 'MOVE_OUT', media: UPLOADED });
    await service.completeRoom(technician, ROOM_ID);
    expect(update).toHaveBeenCalled();
  });
});
