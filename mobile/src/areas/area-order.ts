import type { InspectionRoom } from '../domain/models';
import { demoStorage } from '../storage/demo-storage';

/**
 * The order one technician wants to walk one inspection in.
 *
 * Local to the handset and to the person holding it. It never reaches the
 * server, never touches `PropertyArea.inspectionOrder`, and never changes what
 * anybody else sees — the property layout is the office's, approved through the
 * floor-plan admin, and a working preference must not quietly rewrite it.
 *
 * The report still prints in the property's order. What this changes is the
 * sequence the technician walks the building in, which is theirs to decide:
 * they are the one standing at the front door deciding whether to start
 * upstairs.
 */

const key = (inspectionId: string) => `area-order:${inspectionId}`;

/**
 * Stored as ids rather than positions.
 *
 * Positions would rot the moment an area is added, removed or renamed — a
 * technician can add an area on site, so the set is not fixed while they work.
 * Ids survive all of that, and anything unrecognised is simply ignored.
 */
export async function loadAreaOrder(inspectionId: string): Promise<string[]> {
  try {
    const raw = await demoStorage.getItem(key(inspectionId));
    if (!raw) return [];
    const parsed: unknown = JSON.parse(raw);
    return Array.isArray(parsed) ? parsed.filter((id): id is string => typeof id === 'string') : [];
  } catch {
    // A corrupt or unreadable preference is not worth failing a screen for.
    // The server order is a perfectly good answer.
    return [];
  }
}

export async function saveAreaOrder(inspectionId: string, ids: readonly string[]): Promise<void> {
  try {
    await demoStorage.setItem(key(inspectionId), JSON.stringify(ids));
  } catch {
    // The reorder still applies for this session; it simply will not survive a
    // restart. Losing a preference is not worth interrupting fieldwork.
  }
}

export async function clearAreaOrder(inspectionId: string): Promise<void> {
  try {
    await demoStorage.removeItem(key(inspectionId));
  } catch {
    // Same reasoning as above.
  }
}

/**
 * Applies a saved order by rewriting each room's `order`.
 *
 * Rewriting the field rather than sorting at the call site is deliberate.
 * Three separate places sort by `order` — the area list, `pickUpNextArea`, and
 * `nextInspectionRoom`, which is what the camera advances through after a
 * capture. Sorting in one of them would leave a technician looking at their own
 * order while the app kept offering the server's, which is worse than not
 * offering the feature.
 *
 * Areas the saved order does not mention keep their relative server order and
 * go last. That is the case that matters in the field: an area added on site is
 * new work, and burying it among rooms already walked would hide it.
 */
export function applyAreaOrder<T extends InspectionRoom>(
  rooms: readonly T[],
  order: readonly string[],
): T[] {
  if (!order.length) return [...rooms];

  const rank = new Map(order.map((id, index) => [id, index]));
  // Unmentioned areas sort after every mentioned one, and among themselves by
  // the order the server gave.
  const fallbackBase = order.length;
  const sorted = [...rooms].sort((a, b) => {
    const left = rank.get(a.id);
    const right = rank.get(b.id);
    if (left !== undefined && right !== undefined) return left - right;
    if (left !== undefined) return -1;
    if (right !== undefined) return 1;
    return a.order - b.order;
  });

  return sorted.map((room, index) => ({
    ...room,
    order: rank.get(room.id) ?? fallbackBase + index,
  }));
}
