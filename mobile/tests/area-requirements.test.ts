import type { InspectionRoom } from '../src/domain/models';
import {
  areaCompletionGate,
  deriveAreaRequirements,
  type AreaEvidence,
} from '../src/utils/area-requirements';

function room(baseline: Partial<InspectionRoom['baseline']> = {}): InspectionRoom {
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
      ...baseline,
    },
    completionStatus: 'NOT_STARTED',
    uploadStatus: 'PENDING',
    processingStatus: 'NOT_STARTED',
  };
}

const evidence = (overrides: Partial<AreaEvidence> = {}): AreaEvidence => ({
  hasPrimaryRecording: true,
  photoCount: 0,
  findingCount: 0,
  uploadSettled: true,
  ...overrides,
});

describe('deriveAreaRequirements', () => {
  it('always requires a recording and a settled upload', () => {
    const keys = deriveAreaRequirements(room(), evidence()).map((r) => r.key);
    expect(keys).toContain('recording');
    expect(keys).toContain('upload');
  });

  it('omits the baseline requirement when no baseline exists to review', () => {
    const keys = deriveAreaRequirements(room(), evidence()).map((r) => r.key);
    expect(keys).not.toContain('baseline');
  });

  it('includes the baseline requirement when one is documented', () => {
    const keys = deriveAreaRequirements(room({ condition: 'DOCUMENTED' }), evidence()).map(
      (r) => r.key,
    );
    expect(keys).toContain('baseline');
  });

  it('adds an advisory re-check when prior defects were documented', () => {
    const items = deriveAreaRequirements(
      room({ condition: 'DOCUMENTED', existingDefects: ['Scuffed wall'] }),
      evidence({ photoCount: 0 }),
    );
    const defect = items.find((r) => r.key === 'defect-photos');
    expect(defect?.met).toBe(false);
    // Advisory only — a technician may legitimately find nothing wrong.
    expect(defect?.blocking).toBe(false);
    expect(defect?.hint).toContain('1 defect');
  });

  it('marks the defect re-check met once a photo exists', () => {
    const items = deriveAreaRequirements(
      room({ condition: 'DOCUMENTED', existingDefects: ['Scuffed wall'] }),
      evidence({ photoCount: 2 }),
    );
    expect(items.find((r) => r.key === 'defect-photos')?.met).toBe(true);
  });
});

describe('areaCompletionGate', () => {
  it('permits completion when every blocking requirement is met', () => {
    expect(areaCompletionGate(deriveAreaRequirements(room(), evidence()))).toEqual({
      canComplete: true,
    });
  });

  it('blocks and explains when the recording is missing', () => {
    const gate = areaCompletionGate(
      deriveAreaRequirements(room(), evidence({ hasPrimaryRecording: false })),
    );
    expect(gate.canComplete).toBe(false);
    // A disabled action that does not say why is indistinguishable from a bug.
    expect(gate.reason).toMatch(/Record a walkthrough/i);
  });

  it('blocks when the upload has not been queued', () => {
    const gate = areaCompletionGate(
      deriveAreaRequirements(room(), evidence({ uploadSettled: false })),
    );
    expect(gate.canComplete).toBe(false);
    expect(gate.reason).toMatch(/upload queue/i);
  });

  it('does not block on advisory requirements alone', () => {
    const gate = areaCompletionGate(
      deriveAreaRequirements(
        room({ condition: 'DOCUMENTED', existingDefects: ['Crack'] }),
        evidence({ photoCount: 0 }),
      ),
    );
    expect(gate.canComplete).toBe(true);
  });

  it('always returns a reason string when it blocks', () => {
    const gate = areaCompletionGate(
      deriveAreaRequirements(
        room(),
        evidence({ hasPrimaryRecording: false, uploadSettled: false }),
      ),
    );
    expect(gate.canComplete).toBe(false);
    expect(gate.reason?.length).toBeGreaterThan(0);
  });
});

/**
 * Occupied inspections do not owe a video for every area.
 *
 * They are periodic checks during a tenancy, walked room by room in somebody's
 * home. Where a room is plainly fine a photograph records that as well as a
 * walkthrough does, and requiring the video regardless is what had technicians
 * filming empty hallways to get past a disabled button.
 *
 * A move-in and a move-out are not the same: those are the condition record a
 * comparison is built from, and there the video *is* the evidence.
 */
describe('filming an occupied area', () => {
  const occupied = (overrides = {}) =>
    ({ ...room(), inspectionType: 'OCCUPIED', ...overrides }) as ReturnType<typeof room>;

  it('accepts a photograph instead of a walkthrough', () => {
    const gate = areaCompletionGate(
      deriveAreaRequirements(occupied(), {
        ...evidence(),
        hasPrimaryRecording: false,
        photoCount: 1,
        uploadSettled: false,
      }),
    );
    expect(gate.canComplete).toBe(true);
  });

  it('still refuses an area with no evidence at all', () => {
    // "Not obliged to film" is not "may complete having recorded nothing". An
    // area with neither is one nobody can show was inspected — skipping is the
    // honest way to say there was nothing to capture.
    const gate = areaCompletionGate(
      deriveAreaRequirements(occupied(), {
        ...evidence(),
        hasPrimaryRecording: false,
        photoCount: 0,
        uploadSettled: false,
      }),
    );
    expect(gate.canComplete).toBe(false);
    expect(gate.reason).toMatch(/photograph/i);
  });

  it('does not hold a photo-only area behind an upload that will never happen', () => {
    // `uploadSettled` is derived from a recording. Keeping it blocking with no
    // recording present would leave a condition nothing the technician does can
    // clear — the exact failure the submission gate was extracted to prevent.
    const keys = deriveAreaRequirements(occupied(), {
      ...evidence(),
      hasPrimaryRecording: false,
      photoCount: 2,
      uploadSettled: false,
    }).map((requirement) => requirement.key);
    expect(keys).not.toContain('upload');
  });

  it('still waits for the upload when they did record one', () => {
    const gate = areaCompletionGate(
      deriveAreaRequirements(occupied(), {
        ...evidence(),
        hasPrimaryRecording: true,
        photoCount: 0,
        uploadSettled: false,
      }),
    );
    expect(gate.canComplete).toBe(false);
  });

  it('leaves a move-out demanding the walkthrough', () => {
    // The comparison is built from it. A photograph is not a substitute.
    const gate = areaCompletionGate(
      deriveAreaRequirements({ ...room(), inspectionType: 'MOVE_OUT' } as ReturnType<typeof room>, {
        ...evidence(),
        hasPrimaryRecording: false,
        photoCount: 3,
        uploadSettled: false,
      }),
    );
    expect(gate.canComplete).toBe(false);
    expect(gate.reason).toMatch(/record a walkthrough/i);
  });

  it('leaves a move-in demanding it too', () => {
    const gate = areaCompletionGate(
      deriveAreaRequirements({ ...room(), inspectionType: 'MOVE_IN' } as ReturnType<typeof room>, {
        ...evidence(),
        hasPrimaryRecording: false,
        photoCount: 3,
        uploadSettled: false,
      }),
    );
    expect(gate.canComplete).toBe(false);
  });
});
