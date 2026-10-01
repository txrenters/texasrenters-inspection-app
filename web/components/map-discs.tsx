'use client';

import { memo } from 'react';

import { UNGROUPED_GREEN } from '@/components/planning/group-file';

/**
 * The property markers every map in this console draws: the Group maker's.
 *
 * The office (2026-10-01): the Group maker's map is the better one, and its
 * property markers most of all -- a disc on each property, in its group's
 * colour, rather than a teardrop pin that folded into a count badge as soon as
 * two were near. So these left the Group maker and are drawn by the portfolio
 * on every map, and by the Group maker as before.
 *
 * Drop shadows are CSS, never an SVG filter: ids are document-global, and a
 * filter id shared by many pins left them all without a body once the first
 * one unmounted (see `map-pins.tsx`).
 */

/**
 * A property in a group: a disc in the group's colour, with its stop number on
 * it where it has one.
 *
 * A property placed only at its zip code's centre is drawn pale with a dashed
 * rim, so a pin standing on nobody's house says so before it is clicked.
 */
export const GroupDisc = memo(function GroupDisc({
  fill,
  ink,
  label = null,
  approximate = false,
}: {
  fill: string;
  /** Black or white, whichever reads on `fill`. */
  ink: string;
  /** The stop number, or `·`; null for a plain disc. */
  label?: string | number | null;
  approximate?: boolean;
}) {
  const twoDigits = typeof label === 'number' && label >= 10;
  return (
    <svg
      aria-hidden
      className="cursor-pointer drop-shadow-[0_1px_1px_rgba(0,0,0,0.35)]"
      height="22"
      viewBox="0 0 22 22"
      width="22"
    >
      {approximate ? (
        <>
          <circle cx="11" cy="11" fill="#fff" r="9" />
          <circle cx="11" cy="11" fill={fill} fillOpacity={0.35} r="9" stroke={fill} strokeDasharray="3.5 2" strokeWidth="2.5" />
        </>
      ) : (
        <circle cx="11" cy="11" fill={fill} r="9" stroke="#fff" strokeWidth="2" />
      )}
      {label === null ? null : (
        <text
          dominantBaseline="central"
          fill={approximate ? '#111827' : ink}
          fontFamily="system-ui, sans-serif"
          // A size down for two digits: a group runs to 11 stops, and "11" at the
          // single-digit size reaches the rim.
          fontSize={twoDigits ? 9.5 : 11}
          fontWeight="700"
          letterSpacing={twoDigits ? -0.4 : undefined}
          textAnchor="middle"
          x="50%"
          y="50%"
        >
          {label}
        </text>
      )}
    </svg>
  );
});

/**
 * A small disc with a white rim and no number, for a property in no group.
 *
 * Green -- saturated, so what is left to group stands out on the light roadmap
 * and the dark one alike; grey disappeared into both (the office, 2026-09-30) --
 * for a benefit-package property, and no group colour is ever that green. A
 * wider invisible ring takes the click, because a 13px target is a small one.
 */
export const LooseDisc = memo(function LooseDisc({
  color = UNGROUPED_GREEN,
  rim,
  approximate = false,
}: {
  color?: string;
  /** The edge, where white would vanish -- see `OTHER_PROPERTY_RIM`. White, or the disc's own colour when dashed, otherwise. */
  rim?: string;
  approximate?: boolean;
}) {
  return (
    <svg aria-hidden className="cursor-pointer drop-shadow-[0_1px_1.5px_rgba(0,0,0,0.4)]" height="20" viewBox="0 0 20 20" width="20">
      <circle cx="10" cy="10" fill="transparent" r="10" />
      {approximate ? (
        <>
          <circle cx="10" cy="10" fill="#fff" r="6.5" />
          <circle
            cx="10"
            cy="10"
            fill={color}
            fillOpacity={0.35}
            r="6.5"
            stroke={rim ?? color}
            strokeDasharray="2.5 1.8"
            strokeWidth="2"
          />
        </>
      ) : (
        <circle cx="10" cy="10" fill={color} r="6.5" stroke={rim ?? '#fff'} strokeWidth="2" />
      )}
    </svg>
  );
});

/**
 * Every other active property: off the benefit package, so in no group and not
 * waiting for one.
 *
 * Yellow (the office, 2026-10-02). It was grey, to read as the rest of the
 * portfolio rather than as work to plan, and grey turned out to be hard to find
 * on the map at all. Still not green, which stays the package's.
 */
export const OTHER_PROPERTY_YELLOW = '#facc15';

/**
 * A dark edge for the yellow disc. A pale disc with a white rim disappears into
 * the light roadmap -- the same reason the group palette has no pale yellows.
 */
export const OTHER_PROPERTY_RIM = '#854d0e';

/**
 * A tick on a property's disc: every inspection it had on the day is in (the
 * office, 2026-10-02: "a marker for them indicating that the inspection is
 * completed").
 *
 * White, with a green tick and edge: it has to read on a disc of any of the
 * group colours and on either roadmap, and a green tick is the one mark nobody
 * has to look up. Ignores the pointer, so a click on it is a click on the disc.
 */
export const DoneBadge = memo(function DoneBadge({ className }: { className?: string }) {
  return (
    <svg
      aria-hidden
      className={`pointer-events-none drop-shadow-[0_1px_1px_rgba(0,0,0,0.35)] ${className ?? ''}`}
      height="14"
      viewBox="0 0 14 14"
      width="14"
    >
      <circle cx="7" cy="7" fill="#fff" r="6" stroke="#15803d" strokeWidth="1.25" />
      <path
        d="M4.2 7.2l1.9 1.9 3.7-4"
        fill="none"
        stroke="#15803d"
        strokeLinecap="round"
        strokeLinejoin="round"
        strokeWidth="1.8"
      />
    </svg>
  );
});

/** Clear of a disc's edge, which is 11px from its centre. */
const DISC_CLEARANCE_PX = 12;

/**
 * Where a window stands off its disc, for whichever side Mapbox opens it on.
 *
 * From the disc as drawn, which for a fanned-out disc is not its coordinate,
 * and then clear of the disc's edge on the side the window is on.
 */
export function popupOffsets([x, y]: [number, number]) {
  const diagonal = DISC_CLEARANCE_PX * Math.SQRT1_2;
  return {
    center: [x, y] as [number, number],
    top: [x, y + DISC_CLEARANCE_PX] as [number, number],
    bottom: [x, y - DISC_CLEARANCE_PX] as [number, number],
    left: [x + DISC_CLEARANCE_PX, y] as [number, number],
    right: [x - DISC_CLEARANCE_PX, y] as [number, number],
    'top-left': [x + diagonal, y + diagonal] as [number, number],
    'top-right': [x - diagonal, y + diagonal] as [number, number],
    'bottom-left': [x + diagonal, y - diagonal] as [number, number],
    'bottom-right': [x - diagonal, y - diagonal] as [number, number],
  };
}
