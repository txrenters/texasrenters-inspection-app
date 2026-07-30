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
