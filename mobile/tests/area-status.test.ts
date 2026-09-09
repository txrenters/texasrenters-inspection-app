import type { InspectionRoom } from '../src/domain/models';
import { areaActionLabel, deriveAreaStatus, pickUpNextArea } from '../src/utils/area-status';

function room(overrides: Partial<InspectionRoom> = {}): InspectionRoom {
  return {
    id: 'room-1',
    inspectionId: 'insp-1',
    propertyAreaId: 'area-1',
    name: 'Foyer',
    floorName: 'Ground Floor',
    order: 1,
    isRequired: true,
    inspectionType: 'MOVE_IN',
    baseline: {
      summary: 'No baseline on file',
      condition: 'NOT_AVAILABLE',
      existingDefects: [],
      evidenceCount: 0,
    },
    completionStatus: 'NOT_STARTED',
    uploadStatus: 'PENDING',
    processingStatus: 'NOT_STARTED',
    ...overrides,
  };
}

describe('deriveAreaStatus', () => {
  it('treats skipped and completed as terminal, ahead of any upload state', () => {
    // A finished area must not re-report the upload that got it there.
    expect(
      deriveAreaStatus(room({ completionStatus: 'SKIPPED', uploadStatus: 'FAILED' })).status,
    ).toBe('SKIPPED');
    expect(
      deriveAreaStatus(room({ completionStatus: 'COMPLETED', uploadStatus: 'FAILED' })).status,
    ).toBe('COMPLETED');
  });

  it('surfaces failures ahead of in-flight work', () => {
    // A stalled upload is the one thing the technician must act on.
    expect(
      deriveAreaStatus(room({ completionStatus: 'RECORDING_SAVED', uploadStatus: 'FAILED' })).status,
    ).toBe('UPLOAD_FAILED');
    expect(
      deriveAreaStatus(
        room({
          completionStatus: 'RECORDING_SAVED',
          uploadStatus: 'COMPLETED',
          processingStatus: 'FAILED',
        }),
      ).status,
    ).toBe('PROCESSING_FAILED');
  });

  it('marks failures as needing attention, and quiet states as not', () => {
    expect(
      deriveAreaStatus(room({ completionStatus: 'RECORDING_SAVED', uploadStatus: 'FAILED' }))
        .needsAttention,
    ).toBe(true);
    expect(
      deriveAreaStatus(room({ completionStatus: 'RECORDING_SAVED', uploadStatus: 'UPLOADING' }))
        .needsAttention,
    ).toBe(false);
  });

  it('treats a paused upload as pending, not stalled', () => {
    // Paused resumes on its own when connectivity returns.
    const paused = deriveAreaStatus(
      room({ completionStatus: 'RECORDING_SAVED', uploadStatus: 'PAUSED' }),
    );
    expect(paused.status).toBe('PENDING_UPLOAD');
    expect(paused.needsAttention).toBe(false);
  });

  it('reports a saved-but-unconfirmed recording as queued, not as work outstanding', () => {
    // RECORDING_SAVED means the walkthrough is submitted and the queue owns it.
    // It used to render as "Ready to complete", which described a button that
    // no longer exists and made finished work look outstanding. Completion is
    // now the upload succeeding, so nothing here needs the technician.
    const queued = deriveAreaStatus(
      room({
        completionStatus: 'RECORDING_SAVED',
        uploadStatus: 'COMPLETED',
        processingStatus: 'ANALYZING',
      }),
    );
    expect(queued.status).toBe('PENDING_UPLOAD');
    expect(queued.needsAttention).toBe(false);
  });

  it('treats a server-confirmed upload as complete', () => {
    // The webhook settles on COMPLETED now, but rows written before that change
    // still carry UPLOADED and mean the same thing: the evidence arrived.
    for (const status of ['COMPLETED', 'UPLOADED'] as const) {
      const area = deriveAreaStatus(room({ completionStatus: status }));
      expect(area.status).toBe('COMPLETED');
      expect(area.needsAttention).toBe(false);
    }
  });

  it('only flags an unstarted area as needing attention when it is required', () => {
    expect(deriveAreaStatus(room({ isRequired: true })).needsAttention).toBe(true);
    expect(deriveAreaStatus(room({ isRequired: false })).needsAttention).toBe(false);
  });

  it('always provides a label and a detail line, never colour alone', () => {
    for (const status of [
      room(),
      room({ completionStatus: 'RECORDING_SAVED', uploadStatus: 'FAILED' }),
      room({ completionStatus: 'COMPLETED' }),
      room({ completionStatus: 'SKIPPED', skipReason: 'No access' }),
    ]) {
      const derived = deriveAreaStatus(status);
      expect(derived.label.length).toBeGreaterThan(0);
      expect(derived.detail.length).toBeGreaterThan(0);
    }
  });

  it('includes the skip reason in the detail when one was given', () => {
    expect(
      deriveAreaStatus(room({ completionStatus: 'SKIPPED', skipReason: 'Locked' })).detail,
    ).toContain('Locked');
  });
});

describe('areaActionLabel', () => {
  it('offers an action appropriate to each state', () => {
    expect(areaActionLabel('NOT_STARTED')).toBe('Start area');
    expect(areaActionLabel('READY_TO_COMPLETE')).toBe('Review evidence');
    expect(areaActionLabel('UPLOAD_FAILED')).toBe('Resolve issue');
    expect(areaActionLabel('COMPLETED')).toBe('View area');
  });
});

describe('pickUpNextArea', () => {
  it('returns exactly one area, preferring required work in sequence', () => {
    const rooms = [
      room({ id: 'b', order: 2, isRequired: true }),
      room({ id: 'a', order: 1, isRequired: false }),
      room({ id: 'c', order: 3, isRequired: true }),
    ];
    expect(pickUpNextArea(rooms)?.id).toBe('b');
  });

  it('prioritises an area that needs attention over untouched work', () => {
    const rooms = [
      room({ id: 'fresh', order: 1, isRequired: true }),
      room({
        id: 'failed',
        order: 5,
        isRequired: true,
        completionStatus: 'RECORDING_SAVED',
        uploadStatus: 'FAILED',
      }),
    ];
    expect(pickUpNextArea(rooms)?.id).toBe('failed');
  });

  it('skips completed and skipped areas', () => {
    const rooms = [
      room({ id: 'done', order: 1, completionStatus: 'COMPLETED' }),
      room({ id: 'skipped', order: 2, completionStatus: 'SKIPPED' }),
      room({ id: 'todo', order: 3 }),
    ];
    expect(pickUpNextArea(rooms)?.id).toBe('todo');
  });

  it('returns undefined when every area is finished, so the caller can offer submission', () => {
    const rooms = [
      room({ id: 'a', completionStatus: 'COMPLETED' }),
      room({ id: 'b', completionStatus: 'SKIPPED' }),
    ];
    expect(pickUpNextArea(rooms)).toBeUndefined();
  });

  it('falls back to optional areas when no required work remains', () => {
    const rooms = [
      room({ id: 'req', order: 1, isRequired: true, completionStatus: 'COMPLETED' }),
      room({ id: 'opt', order: 2, isRequired: false }),
    ];
    expect(pickUpNextArea(rooms)?.id).toBe('opt');
  });
});

/**
 * Reported from the field, 2026-09-10: "it doesn't detect if the area
 * inspection has started already if I just take a photo."
 *
 * Every other branch of `deriveAreaStatus` reads `completionStatus` and
 * `uploadStatus`, and both describe a *recording*. So an area a technician had
 * photographed and nothing else fell through to "Not started — not yet
 * recorded", which is false twice over: they had started it, and on an occupied
 * visit a photograph is the evidence rather than a step towards one.
 */
describe('an area with photographs and no recording', () => {
  const photographed = (photoCount: number, overrides: Partial<InspectionRoom> = {}) =>
    deriveAreaStatus(
      room({
        completionStatus: 'NOT_STARTED',
        uploadStatus: 'PENDING',
        processingStatus: 'NOT_STARTED',
        photoCount,
        ...overrides,
      }),
    );

  it('reads as in progress, not as not started', () => {
    expect(photographed(3).status).toBe('IN_PROGRESS');
    expect(photographed(3).label).toBe('In progress');
  });

  it('says how many photographs it holds', () => {
    expect(photographed(1).detail).toContain('1 photo saved');
    expect(photographed(4).detail).toContain('4 photos saved');
  });

  it('stops nagging a required area that has been started', () => {
    // `needsAttention` drives the required-and-untouched warning. An area with
    // photographs is neither.
    expect(photographed(2, { isRequired: true }).needsAttention).toBe(false);
  });

  it('still reads as not started with no photographs', () => {
    expect(photographed(0).status).toBe('NOT_STARTED');
  });

  it('treats a missing count as none, for a room cached before the field existed', () => {
    expect(deriveAreaStatus(room({ completionStatus: 'NOT_STARTED' })).status).toBe('NOT_STARTED');
  });

  it('lets a failed upload outrank the photographs', () => {
    // A broken recording is the more urgent thing to say about an area that has
    // both, which is why the photograph branch sits below the upload ones.
    expect(
      photographed(2, { completionStatus: 'RECORDING_SAVED', uploadStatus: 'FAILED' }).status,
    ).toBe('UPLOAD_FAILED');
  });
});
