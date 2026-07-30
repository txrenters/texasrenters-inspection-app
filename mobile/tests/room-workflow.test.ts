import type { InspectionRoom } from '../src/domain/models';
import { nextInspectionRoom } from '../src/utils/room-workflow';

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

describe('mobile v2 offline-first room progression', () => {
  const rooms = [
    room('living', 1, 'COMPLETED'),
    room('dining', 2, 'NOT_STARTED'),
    room('kitchen', 3, 'NOT_STARTED'),
    room('patio', 4, 'NOT_STARTED', false),
  ];

  it('picks the first unfinished required room', () => {
    expect(nextInspectionRoom(rooms)?.id).toBe('dining');
  });

  it('advances immediately after queueing evidence without waiting for upload', () => {
    expect(nextInspectionRoom(rooms, 'dining')?.id).toBe('kitchen');
  });

  it('does not force an optional room after required work is queued', () => {
    const queued = rooms.map((item) =>
      item.id === 'kitchen'
        ? { ...item, completionStatus: 'RECORDING_SAVED' as const }
        : item,
    );
    expect(nextInspectionRoom(queued, 'dining')).toBeUndefined();
  });
});
