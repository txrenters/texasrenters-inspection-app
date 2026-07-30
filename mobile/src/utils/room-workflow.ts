import type { InspectionRoom } from '../domain/models';

export function isRoomPending(room: InspectionRoom) {
  return !['RECORDING_SAVED', 'COMPLETED', 'SKIPPED'].includes(room.completionStatus);
}

/**
 * Returns the next unfinished approved area in server-defined inspection order.
 * After a capture, the current room is deliberately excluded because the local
 * queue is the source of truth until the backend confirms its upload.
 */
export function nextInspectionRoom(rooms: InspectionRoom[], currentRoomId?: string) {
  // Optional areas remain available in the checklist but never block submission
  // or force the technician into extra field work.
  const ordered = [...rooms]
    .sort((left, right) => left.order - right.order)
    .filter((room) => room.isRequired);
  if (!currentRoomId) return ordered.find(isRoomPending);

  const currentIndex = ordered.findIndex((room) => room.id === currentRoomId);
  const afterCurrent = currentIndex >= 0 ? ordered.slice(currentIndex + 1) : ordered;
  return (
    afterCurrent.find(isRoomPending) ??
    ordered.find((room) => room.id !== currentRoomId && isRoomPending(room))
  );
}
