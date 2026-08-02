import type { Finding, InspectionRoom } from '../src/domain/models';
import { ROOM_SUMMARY_TITLE } from '../src/utils/ai-review';
import {
  buildPriorityChecklist,
  countByPriority,
  summaryCoverage,
} from '../src/utils/inspection-audit';

function finding(overrides: Partial<Finding> = {}): Finding {
  return {
    id: 'finding-1',
    inspectionId: 'insp-1',
    roomId: 'room-1',
    roomName: 'Kitchen',
    title: 'Scuffed wall',
    category: 'Walls',
    severity: 'LOW',
    comparisonResult: 'EXISTING_CONDITION',
    confidence: 0.9,
    videoTimestampStart: 0,
    videoTimestampEnd: 5,
    baselineCondition: '',
    observation: '',
    aiSummary: '',
    recommendedReview: '',
    ...(overrides as Partial<Finding>),
  } as Finding;
}

function room(overrides: Partial<InspectionRoom> = {}): InspectionRoom {
  return {
    id: 'room-1',
    inspectionId: 'insp-1',
    propertyAreaId: 'area-1',
    name: 'Kitchen',
    floorName: 'Ground',
    order: 1,
    isRequired: true,
    inspectionType: 'MOVE_OUT',
    baseline: { summary: '', condition: 'NOT_AVAILABLE', existingDefects: [], evidenceCount: 0 },
    completionStatus: 'COMPLETED',
    uploadStatus: 'UPLOADED',
    processingStatus: 'READY',
    ...(overrides as Partial<InspectionRoom>),
  } as InspectionRoom;
}

describe('buildPriorityChecklist', () => {
  it('puts missing evidence first — it is the only item still fixable on site', () => {
    const items = buildPriorityChecklist([
      finding({ id: 'a', severity: 'LOW', comparisonResult: 'EXISTING_CONDITION' }),
      finding({ id: 'b', comparisonResult: 'MISSING_EVIDENCE' }),
    ]);
    expect(items[0]?.findingId).toBe('b');
    expect(items[0]?.priority).toBe('ACT_NOW');
    expect(items[0]?.reason).toMatch(/recapture/i);
  });

  it('treats high-severity possible new damage as act-now', () => {
    const items = buildPriorityChecklist([
      finding({ severity: 'HIGH', comparisonResult: 'POSSIBLE_NEW_DAMAGE' }),
    ]);
    expect(items).toHaveLength(1);
    expect(items[0]?.priority).toBe('ACT_NOW');
  });

  it('orders by priority, then severity, then room', () => {
    const items = buildPriorityChecklist([
      finding({ id: 'low', severity: 'LOW', roomName: 'Attic' }),
      finding({ id: 'high', severity: 'HIGH' }),
      finding({ id: 'gap', comparisonResult: 'INSUFFICIENT_DATA' }),
    ]);
    expect(items.map((item) => item.findingId)).toEqual(['gap', 'high', 'low']);
  });

  it('never lists a room summary as an action item', () => {
    // Summaries are narrative context for reviewers. Listing them would bury
    // the findings that actually need attention.
    const items = buildPriorityChecklist([
      finding({ id: 'summary', title: ROOM_SUMMARY_TITLE }),
      finding({ id: 'real' }),
    ]);
    expect(items.map((item) => item.findingId)).toEqual(['real']);
  });

  it('flags a low-confidence read for a human regardless of priority', () => {
    const items = buildPriorityChecklist([finding({ confidence: 0.4 })]);
    expect(items).toHaveLength(1);
    expect(items[0]?.lowConfidence).toBe(true);
    expect(items[0]?.reason).toMatch(/unsure/i);
  });

  it('does not imply who pays', () => {
    // Responsibility is an administrator determination. A technician-facing
    // priority must not pre-judge it.
    const items = buildPriorityChecklist([
      finding({ comparisonResult: 'OWNER_MAINTENANCE' }),
      finding({ id: 'b', comparisonResult: 'NORMAL_WEAR' }),
    ]);
    for (const item of items) {
      expect(item.reason).not.toMatch(/tenant|charge|bill|pay/i);
    }
  });
});

describe('summaryCoverage', () => {
  it('reports a finished area the AI produced no summary for', () => {
    // The pipeline is best-effort per recording: one area's analysis can fail
    // while every other succeeds, and nothing surfaced that gap.
    const coverage = summaryCoverage(
      [room({ id: 'room-1' }), room({ id: 'room-2', name: 'Bath' })],
      [finding({ roomId: 'room-1', title: ROOM_SUMMARY_TITLE })],
    );
    expect(coverage.covered).toBe(1);
    expect(coverage.total).toBe(2);
    expect(coverage.missing.map((area) => area.roomId)).toEqual(['room-2']);
  });

  it('does not count an area still being worked', () => {
    const coverage = summaryCoverage([room({ completionStatus: 'RECORDING_SAVED' })], []);
    expect(coverage.total).toBe(0);
    expect(coverage.missing).toEqual([]);
  });

  it('does not treat a skipped area as a gap', () => {
    // A skip is a recorded decision with a reason. There is no video, so there
    // is nothing to summarise and nothing missing.
    const coverage = summaryCoverage([room({ completionStatus: 'SKIPPED' })], []);
    expect(coverage.total).toBe(0);
  });

  it('counts findings per area without counting the summary itself', () => {
    const coverage = summaryCoverage(
      [room({ id: 'room-1' })],
      [
        finding({ id: 's', roomId: 'room-1', title: ROOM_SUMMARY_TITLE }),
        finding({ id: 'f1', roomId: 'room-1' }),
        finding({ id: 'f2', roomId: 'room-1' }),
      ],
    );
    expect(coverage.areas[0]).toMatchObject({ hasSummary: true, findingCount: 2 });
  });
});

describe('countByPriority', () => {
  it('counts each band', () => {
    const items = buildPriorityChecklist([
      finding({ id: 'a', comparisonResult: 'MISSING_EVIDENCE' }),
      finding({ id: 'b', severity: 'HIGH' }),
      finding({ id: 'c' }),
    ]);
    expect(countByPriority(items)).toEqual({ actNow: 1, review: 1, monitor: 1 });
  });
});
