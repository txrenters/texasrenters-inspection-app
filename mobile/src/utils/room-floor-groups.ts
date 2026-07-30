import type { InspectionRoom } from '../domain/models';

export interface RoomFloorGroup {
  floorName: string;
  rooms: InspectionRoom[];
}

export function groupRoomsByFloor(rooms: InspectionRoom[]): RoomFloorGroup[] {
  const groups = new Map<string, InspectionRoom[]>();
  for (const room of rooms) {
    const floorName = room.floorName.trim() || 'No floor';
    const floorRooms = groups.get(floorName);
    if (floorRooms) floorRooms.push(room);
    else groups.set(floorName, [room]);
  }
  return [...groups].map(([floorName, floorRooms]) => ({ floorName, rooms: floorRooms }));
}
