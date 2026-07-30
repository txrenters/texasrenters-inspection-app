import type { AreaEnvironment } from '../domain/models';

// Bump when the recommended sequence changes; recordings can reference the
// version they were captured under (persisted server-side in a later phase).
export const VIDEO_GUIDE_VERSION = '2026-07-25.1';

export const INDOOR_VIDEO_STEPS: readonly string[] = [
  'Begin at the room or area entrance.',
  'State the property, area name, and inspection type when required.',
  'Start with a wide view from the doorway.',
  'Record the area clockwise through roughly 360 degrees.',
  'Capture each wall from top to bottom.',
  'Include ceiling, floor, doors, windows, closets, fixtures, and built-ins.',
  'Pause briefly on visible defects.',
  'Describe each finding clearly out loud.',
  'Capture utilities, appliances, or safety devices relevant to the area.',
  'End with any additional issue that needs focused coverage.',
];

export const OUTDOOR_VIDEO_STEPS: readonly string[] = [
  'Start from a clear reference point.',
  'Move clockwise around the area or property perimeter.',
  'Capture fencing, gates, walls, ground surfaces, drainage, landscaping, structures, and visible damage.',
  'Avoid unsafe movement or trespassing.',
];

export function videoStepsForEnvironment(environment?: AreaEnvironment): readonly string[] {
  return environment === 'OUTDOOR' || environment === 'SEMI_OUTDOOR'
    ? OUTDOOR_VIDEO_STEPS
    : INDOOR_VIDEO_STEPS;
}
