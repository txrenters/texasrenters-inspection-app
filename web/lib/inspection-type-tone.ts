import { INSPECTION_TYPE_CHILDREN } from '@/lib/admin-navigation';
import { humanize } from '@/lib/format';

/**
 * Each inspection type's colour, as Jobber colours its records (a request is
 * orange, a job green, an invoice blue) so a type is told apart at a glance:
 * the Create menu's tiles and the Schedule's visits use the same one.
 *
 * The categorical chart tokens, which are measured for exactly that. Spelled
 * out as whole class names because Tailwind only generates the classes it can
 * read in the source.
 */
export interface TypeTone {
  /** The type's mark or icon. */
  text: string;
  /** A visit's left edge. */
  bar: string;
  /** A visit's fill, and its hover. */
  tint: string;
  /** A line on the map. */
  stroke: string;
}

const TONES: Record<string, TypeTone> = {
  MOVE_IN: { text: 'text-chart-5', bar: 'border-l-chart-5', tint: 'bg-chart-5/10 hover:bg-chart-5/20', stroke: 'stroke-chart-5' },
  OCCUPIED: { text: 'text-chart-1', bar: 'border-l-chart-1', tint: 'bg-chart-1/10 hover:bg-chart-1/20', stroke: 'stroke-chart-1' },
  BACK_TO_MARKET: { text: 'text-chart-4', bar: 'border-l-chart-4', tint: 'bg-chart-4/10 hover:bg-chart-4/20', stroke: 'stroke-chart-4' },
  MOVE_OUT: { text: 'text-chart-3', bar: 'border-l-chart-3', tint: 'bg-chart-3/10 hover:bg-chart-3/20', stroke: 'stroke-chart-3' },
  HVAC: { text: 'text-chart-2', bar: 'border-l-chart-2', tint: 'bg-chart-2/10 hover:bg-chart-2/20', stroke: 'stroke-chart-2' },
};

/** The types without a sidebar section of their own (roof, supra, filter delivery…). */
const OTHER: TypeTone = {
  text: 'text-muted-foreground',
  bar: 'border-l-muted-foreground',
  tint: 'bg-muted hover:bg-accent',
  stroke: 'stroke-muted-foreground',
};

export function typeTone(type: string | null | undefined): TypeTone {
  return (type && TONES[type]) || OTHER;
}

const TITLES = new Map(INSPECTION_TYPE_CHILDREN.map((child) => [child.type, child.title]));

/** "Move-in", "Back-to-market": the sidebar's spelling, else the enum in words. */
export function typeTitle(type: string | null | undefined): string {
  if (!type) return 'Inspection';
  return TITLES.get(type) ?? humanize(type);
}
