import type { AreaEnvironment, InspectionRoom } from '../domain/models';

export interface AreaCategoryOption {
  value: string;
  label: string;
  environment: AreaEnvironment;
}

// Mirrors the backend AreaCategory enum, annotated with a default environment so
// the Add Area form can suggest indoor vs outdoor as the technician picks.
export const AREA_CATEGORIES: readonly AreaCategoryOption[] = [
  { value: 'INDOOR_ROOM', label: 'Indoor room', environment: 'INDOOR' },
  { value: 'HALLWAY', label: 'Hallway', environment: 'INDOOR' },
  { value: 'STAIRWAY', label: 'Stairway', environment: 'INDOOR' },
  { value: 'CLOSET', label: 'Closet', environment: 'INDOOR' },
  { value: 'UTILITY', label: 'Utility', environment: 'INDOOR' },
  { value: 'ATTIC', label: 'Attic', environment: 'INDOOR' },
  { value: 'BASEMENT', label: 'Basement', environment: 'INDOOR' },
  { value: 'GARAGE', label: 'Garage', environment: 'SEMI_OUTDOOR' },
  { value: 'BALCONY', label: 'Balcony', environment: 'SEMI_OUTDOOR' },
  { value: 'PATIO', label: 'Patio', environment: 'OUTDOOR' },
  { value: 'PORCH', label: 'Porch', environment: 'OUTDOOR' },
  { value: 'DRIVEWAY', label: 'Driveway', environment: 'OUTDOOR' },
  { value: 'YARD', label: 'Yard', environment: 'OUTDOOR' },
  { value: 'EXTERIOR_WALL', label: 'Exterior wall', environment: 'OUTDOOR' },
  { value: 'ROOF', label: 'Roof', environment: 'OUTDOOR' },
  { value: 'PERIMETER_FENCE', label: 'Perimeter fence', environment: 'OUTDOOR' },
  { value: 'GATE', label: 'Gate', environment: 'OUTDOOR' },
  { value: 'POOL', label: 'Pool', environment: 'OUTDOOR' },
  { value: 'SHED', label: 'Shed', environment: 'OUTDOOR' },
  { value: 'OTHER_OUTDOOR', label: 'Other outdoor', environment: 'OUTDOOR' },
  { value: 'OTHER', label: 'Other', environment: 'INDOOR' },
];

export const AREA_ENVIRONMENTS: ReadonlyArray<{ value: AreaEnvironment; label: string }> = [
  { value: 'INDOOR', label: 'Indoor' },
  { value: 'OUTDOOR', label: 'Outdoor' },
  { value: 'SEMI_OUTDOOR', label: 'Semi-outdoor' },
];

export function formatAreaEnvironment(environment: AreaEnvironment): string {
  return AREA_ENVIRONMENTS.find((option) => option.value === environment)?.label ?? environment;
}

export type AreaGroupKey = 'INDOOR' | 'OUTDOOR' | 'MANUAL';

/**
 * Splits rooms into the three technician-facing sections from the workflow:
 * indoor areas, outdoor areas, and manually added areas (any technician-created
 * area, regardless of environment, so the technician can find what they added).
 */
export function groupRoomsBySection(rooms: InspectionRoom[]): Array<{
  key: AreaGroupKey;
  label: string;
  rooms: InspectionRoom[];
}> {
  const indoor: InspectionRoom[] = [];
  const outdoor: InspectionRoom[] = [];
  const manual: InspectionRoom[] = [];
  for (const room of rooms) {
    if (room.source === 'TECHNICIAN') manual.push(room);
    else if ((room.environment ?? 'INDOOR') === 'INDOOR') indoor.push(room);
    else outdoor.push(room);
  }
  const sections: Array<{ key: AreaGroupKey; label: string; rooms: InspectionRoom[] }> = [
    { key: 'INDOOR', label: 'Indoor areas', rooms: indoor },
    { key: 'OUTDOOR', label: 'Outdoor areas', rooms: outdoor },
    { key: 'MANUAL', label: 'Manually added areas', rooms: manual },
  ];
  return sections.filter((section) => section.rooms.length > 0);
}
