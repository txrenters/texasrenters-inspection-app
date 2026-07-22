import type { InspectionRoom } from '../src/domain/models';
import { groupRoomsByFloor } from '../src/utils/room-floor-groups';

describe('groupRoomsByFloor', () => {
  it('preserves server floor and room order', () => {
    const rooms = [
      room('ground-entry', 'Ground Floor', 1),
      room('ground-kitchen', 'Ground Floor', 2),
      room('second-bedroom', 'Second Floor', 3),
    ];

    expect(groupRoomsByFloor(rooms)).toEqual([
      { floorName: 'Ground Floor', rooms: [rooms[0], rooms[1]] },
      { floorName: 'Second Floor', rooms: [rooms[2]] },
    ]);
  });
});

function room(id: string, floorName: string, order: number): InspectionRoom {
  return {
    id,
    inspectionId: 'inspection-1',
    propertyAreaId: `area-${id}`,
    name: id,
    floorName,
    order,
    isRequired: true,
    inspectionType: 'MOVE_IN',
    baseline: {
      summary: '',
      condition: 'NOT_AVAILABLE',
      existingDefects: [],
      evidenceCount: 0,
    },
    completionStatus: 'NOT_STARTED',
    uploadStatus: 'PENDING',
    processingStatus: 'NOT_STARTED',
  };
}
