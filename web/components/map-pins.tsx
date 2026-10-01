/**
 * The marks on the map, and nothing about the map itself.
 *
 * Pure SVG in React, so they render as the child of a marker whatever draws
 * it. That is why they are here rather than beside the map: they came through
 * the move from Leaflet to Google untouched, and through the move from Google
 * to Mapbox untouched, while everything around them was rewritten twice.
 *
 * The two subjects are separated by **shape as well as colour** -- a property
 * is a teardrop pin planted at a spot, a technician a round badge with a
 * person in it. Anyone who cannot reliably tell green from red still reads the
 * map correctly, which colour alone would not give them.
 *
 * White outlines on all of them. These sit on cartography full of green parks,
 * blue water and red arterial roads, and an unoutlined marker disappears into
 * whatever it happens to land on.
 */
'use client';

import { memo } from 'react';

import { useContinuousRotation } from '@/lib/map-animation';

/**
 * The shadow that lifts a marker off the map, as a class.
 *
 * **It used to be an SVG filter, and that was a bug that hid the markers.**
 * Every pin rendered its own `<defs><filter id="pin-shadow">`, and an SVG id is
 * global to the document however many times it is declared -- so every pin
 * referencing it by url resolved to whichever copy happened to be first in
 * the DOM. When that marker unmounted, which happens constantly as the map
 * pans and re-clusters, the reference dangled. Chrome follows SVG 1.1 there:
 * an element whose filter cannot be resolved **is not rendered at all**.
 *
 * So the coloured body of each pin disappeared and only the white glyph inside
 * it survived, leaving pale ghosts scattered over the map -- reported as "the
 * marking on the map for each property is broken", which it was.
 *
 * A CSS drop-shadow needs no id, so there is nothing to collide and nothing to
 * dangle. The two planning maps had already been drawn this way.
 *
 * The value is written out rather than using `drop-shadow-sm`, which is far
 * lighter (0.05 against 0.35): these sit on satellite imagery, where the shadow
 * is most of what separates a marker from the ground under it.
 */
const SHADOW = 'drop-shadow-[0_1px_1px_rgba(0,0,0,0.35)]';

/**
 * A round badge with a person in it, anchored at its centre.
 *
 * Centred rather than pointed, because unlike a property this is a reading of
 * where somebody was, not a marked spot — and the accuracy circle it sits
 * inside is drawn from the same centre.
 *
 * The canvas is 44px while the badge is still 22px across: the extra room is
 * for the pulse, which expands past the badge and would otherwise be clipped.
 *
 * No icon cache any more. Leaflet replaced a marker's whole DOM whenever the
 * `icon` prop was a new object, so a freshly built icon on every render
 * restarted the pulse from zero and read as a stutter; three cached instances
 * were the fix. React reconciles this instead — the `<circle>` survives a
 * re-render, and so does its animation.
 */
export const TechnicianPin = memo(function TechnicianPin({
  stale,
  dim = false,
  heading = null,
  ring = null,
}: {
  stale: boolean;
  dim?: boolean;
  /**
   * Their colour on the map, as a ring round the badge -- the colour of their
   * trail and their planned route, so the line and the person are matched
   * without a legend. Null draws none.
   */
  ring?: string | null;
  /**
   * Course over ground, or null to draw no arrow at all.
   *
   * Null is the common case and it matters that it stays empty: a technician
   * standing in a kitchen has no course, and an arrow left over from the drive
   * in would keep asserting a direction they stopped travelling ten minutes
   * ago. The caller decides, from `motionOf`, rather than this component
   * guessing from a speed it was not given. A technician on the road gets
   * `DrivingPin` instead; this tick is for somebody moving on foot.
   */
  heading?: number | null;
}) {
  const fill = stale ? 'fill-map-technician-stale' : 'fill-map-technician';
  /**
   * Whether this person is reporting now -- and nothing else.
   *
   * This used to be `!stale && !dim`, which conflated two unrelated facts.
   * `stale` is about the technician: they have not reported for half an hour.
   * `dim` is about the *reader*: somebody else is selected. Suppressing the
   * pulse for the second reason made selecting one technician appear to take
   * everybody else offline -- reported as a bug, and it was one: the map was
   * answering "is this person out there" with "did you click on them".
   *
   * De-emphasis is the `opacity` below, which fades the pulse along with the
   * rest of the marker. That is what dimming should do: make something quieter
   * without changing what it says.
   */
  const live = !stale;

  return (
    /* 0.45 rather than 0.3. At 0.3 an online marker's colour was too faint to
       separate from the stale one, so the dimming was itself reading as
       offline -- the same bug by a different route. */
    <svg className={SHADOW} height="44" opacity={dim ? 0.45 : 1} viewBox="0 0 44 44" width="44">
      {live ? (
        <circle className="map-technician-pulse fill-map-technician" cx="22" cy="22" r="11" />
      ) : null}
      {ring ? <circle cx="22" cy="22" fill="none" r="14" stroke={ring} strokeWidth="3" /> : null}
      {/* Rotated about the marker's own centre, which is also the coordinate
          the marker is anchored at -- so the arrow swings around the person
          rather than orbiting some other point.

          Screen-up is north because the map is never rotated: tilt changes the
          camera's pitch, not its bearing, so 0 degrees keeps pointing at the
          top of the window even in the 3D view. If a rotation control is ever
          added this must subtract the map's heading. */}
      {heading === null ? null : (
        <g transform={`rotate(${heading} 22 22)`}>
          <path
            className={fill}
            d="M22 1.5 L26.6 10.5 L22 8.4 L17.4 10.5 Z"
            stroke="#fff"
            strokeLinejoin="round"
            strokeWidth="1.5"
          />
        </g>
      )}
      <g transform="translate(8,8)">
        <circle className={fill} cx="14" cy="14" r="11" stroke="#fff" strokeWidth="2.5" />
        <circle cx="14" cy="11.1" fill="#fff" r="2.9" />
        <path d="M8.1 20.4c0-3.2 2.7-5.2 5.9-5.2s5.9 2 5.9 5.2z" fill="#fff" />
      </g>
    </svg>
  );
});

/**
 * A technician on the road: an arrow pointing the way they are driving.
 *
 * The navigation-app arrow rather than the person badge, because on a drive the
 * question is which way, and a badge with a small tick on its rim answered it
 * at a size nobody could read from across a desk. A white disc behind it keeps
 * it legible on a dark basemap, a satellite image, and a green park alike.
 *
 * Turned with a CSS transition, the short way round, so a heading that moves
 * from 350° to 10° is a slight right, not a spin. The pulse goes when they are
 * stopped mid-drive: still on the road, but not going anywhere this second.
 */
export const DrivingPin = memo(function DrivingPin({
  dim = false,
  heading,
  stopped = false,
  ring = null,
}: {
  dim?: boolean;
  heading: number;
  stopped?: boolean;
  /** Their colour on the map, as `TechnicianPin` draws it. */
  ring?: string | null;
}) {
  const rotation = useContinuousRotation(heading);
  return (
    <svg className={SHADOW} height="44" opacity={dim ? 0.45 : 1} viewBox="0 0 44 44" width="44">
      {stopped ? null : (
        <circle className="map-technician-pulse fill-map-technician" cx="22" cy="22" r="13" />
      )}
      <circle cx="22" cy="22" fill="#fff" r="14.5" />
      {ring ? <circle cx="22" cy="22" fill="none" r="16" stroke={ring} strokeWidth="3" /> : null}
      <path
        className="fill-map-technician"
        d="M22 9.5 L30 31.5 L22 26.8 L14 31.5 Z"
        stroke="#fff"
        strokeLinejoin="round"
        strokeWidth="1"
        style={{
          transform: `rotate(${rotation}deg)`,
          transformOrigin: '22px 22px',
          transition: 'transform 700ms ease-out',
        }}
      />
    </svg>
  );
});

/**
 * A numbered stop on the recommended route.
 *
 * Green for the next stop -- where the technician is heading -- and the route's
 * orange for the rest.
 */
export const StopPin = memo(function StopPin({ order, next = false }: { order: number; next?: boolean }) {
  return (
    <svg height="24" viewBox="0 0 24 24" width="24">
      <circle
        className={next ? 'fill-map-route-next' : 'fill-map-route'}
        cx="12"
        cy="12"
        r="10"
        stroke="#fff"
        strokeWidth="2"
      />
      <text
        dominantBaseline="central"
        fill="#fff"
        fontFamily="system-ui, sans-serif"
        fontSize="11"
        fontWeight="700"
        textAnchor="middle"
        x="50%"
        y="50%"
      >
        {order}
      </text>
    </svg>
  );
});

/** A stop already finished: grey and ticked, out of the way of what is left. */
export const DonePin = memo(function DonePin() {
  return (
    <svg height="20" viewBox="0 0 24 24" width="20">
      <circle className="fill-map-route-done" cx="12" cy="12" r="10" stroke="#fff" strokeWidth="2" />
      <path
        d="M7.5 12.5l3 3 6-6.5"
        fill="none"
        stroke="#fff"
        strokeLinecap="round"
        strokeLinejoin="round"
        strokeWidth="2.4"
      />
    </svg>
  );
});

/** A plane, marking a journey nobody is driving. */
export const PlanePin = memo(function PlanePin() {
  return (
    <svg height="26" viewBox="0 0 24 24" width="26">
      <circle className="fill-map-air" cx="12" cy="12" r="11" stroke="#fff" strokeWidth="2" />
      <path
        d="M12 4.6c.5 0 .9.4.9.9v3.2l4.7 2.8v1.3l-4.7-1.4v3.3l1.6 1.2v1L12 17.4l-2.5.5v-1l1.6-1.2v-3.3l-4.7 1.4v-1.3l4.7-2.8V5.5c0-.5.4-.9.9-.9z"
        fill="#fff"
      />
    </svg>
  );
});
