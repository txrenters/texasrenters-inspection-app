import type { InspectionRoom } from '../src/domain/models';
import { nextInspectionRoom } from '../src/utils/room-workflow';

describe('room inspection workflow', () => {
  const rooms = [
    room('living', 1, 'COMPLETED'),
    room('dining', 2, 'NOT_STARTED'),
    room('kitchen', 3, 'NOT_STARTED'),
    room('patio', 4, 'NOT_STARTED', false),
  ];

  it('starts with the first pending approved room in inspection order', () => {
    expect(nextInspectionRoom(rooms)?.id).toBe('dining');
  });

  it('advances after the captured room without waiting for its upload', () => {
    expect(nextInspectionRoom(rooms, 'dining')?.id).toBe('kitchen');
  });

  it('skips locally queued rooms without forcing optional areas', () => {
    const state = rooms.map((item) =>
      item.id === 'kitchen' ? { ...item, completionStatus: 'RECORDING_SAVED' as const } : item,
    );
    expect(nextInspectionRoom(state, 'dining')).toBeUndefined();
  });
});

function room(
  id: string,
  order: number,
  completionStatus: InspectionRoom['completionStatus'],
  isRequired = true,
): InspectionRoom {
  return {
    id,
    inspectionId: 'inspection-1',
    propertyAreaId: `area-${id}`,
    name: id,
    floorName: 'Ground Floor',
    order,
    isRequired,
    inspectionType: 'MOVE_IN',
    baseline: {
      summary: '',
      condition: 'NOT_AVAILABLE',
      existingDefects: [],
      evidenceCount: 0,
    },
    completionStatus,
    uploadStatus: 'PENDING',
    processingStatus: 'NOT_STARTED',
  };
}
