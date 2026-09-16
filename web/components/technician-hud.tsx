'use client';

import { isLocationPaused, type TechnicianPosition } from '@texasrenters/shared';
import { InfoIcon, LocateFixedIcon, LocateIcon, TriangleAlertIcon } from 'lucide-react';
import { useEffect, useState } from 'react';

import { MAP_OVERLAY_ATTRIBUTE } from '@/components/map-camera';
import { Button } from '@/components/ui/button';
import { formatCompass, formatDuration } from '@/lib/format';
import { motionOf, speedKmh, type Motion, type MotionSample } from '@/lib/technician-motion';
import { trackingProblem, trackingSummary } from '@/lib/tracking-status';
import { cn } from '@/lib/utils';

/**
 * The followed technician's speed and heading, along the bottom of the map.
 *
 * The way a navigation app shows a drive: how fast, which way, and whether any
 * of it is current. It sits inside the map as a Google control, not over it, so
 * it stays on screen in fullscreen and Google keeps it clear of its own logo
 * and buttons.
 */

const overlay = { [MAP_OVERLAY_ATTRIBUTE]: '' };

/** The clock, ticking, so "8s ago" and "no update for 4 min" stay true. */
function useNow(intervalMs: number) {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const timer = setInterval(() => setNow(Date.now()), intervalMs);
    return () => clearInterval(timer);
  }, [intervalMs]);
  return now;
}

/**
 * How long ago, to the second while it is seconds.
 *
 * `formatRelative` stops at minutes, which is right for a row in a table and
 * wrong here: on a live drive the difference between four seconds and fifty is
 * the whole question.
 */
export function formatAge(milliseconds: number) {
  const seconds = Math.max(0, Math.round(milliseconds / 1000));
  if (seconds < 5) return 'just now';
  if (seconds < 60) return `${seconds}s ago`;
  const minutes = Math.round(seconds / 60);
  if (minutes < 60) return `${minutes} min ago`;
  const hours = Math.floor(minutes / 60);
  return `${hours} hr ago`;
}

type Tone = 'live' | 'quiet' | 'warning';

/** What to call what they are doing, and how loudly. */
export function describeMotion(
  motion: Motion | null,
  { paused, now }: { paused: boolean; now: number },
): { label: string; tone: Tone } {
  if (paused) return { label: 'Location paused', tone: 'warning' };
  if (!motion) return { label: 'No location yet', tone: 'quiet' };
  if (!motion.live) return { label: `No update for ${formatAge(now - motion.recordedAt).replace(' ago', '')}`, tone: 'warning' };
  switch (motion.state) {
    case 'DRIVING':
      return { label: 'Driving', tone: 'live' };
    case 'STOPPED':
      return { label: 'Stopped', tone: 'live' };
    case 'ON_FOOT':
      return { label: 'On foot', tone: 'live' };
    default:
      return { label: 'Not moving', tone: 'quiet' };
  }
}

/** A small compass needle, turned to the heading. */
function HeadingNeedle({ heading }: { heading: number | null }) {
  return (
    <svg aria-hidden className="size-9 shrink-0" viewBox="0 0 36 36">
      <circle className="fill-muted stroke-border" cx="18" cy="18" r="16.5" strokeWidth="1" />
      {heading === null ? (
        <circle className="fill-muted-foreground" cx="18" cy="18" r="2.5" />
      ) : (
        <path
          className="fill-map-technician"
          d="M18 6 L24 27 L18 23 L12 27 Z"
          style={{
            transform: `rotate(${heading}deg)`,
            transformOrigin: '18px 18px',
            transition: 'transform 700ms ease-out',
          }}
        />
      )}
    </svg>
  );
}

function Cell({ children, className }: { children: React.ReactNode; className?: string }) {
  return <div className={cn('flex min-w-0 items-center gap-2.5 px-3.5 py-2', className)}>{children}</div>;
}

export function TechnicianHud({
  nextStop,
  position,
  track,
}: {
  /** The first stop still ahead of them, with the drive to it. */
  nextStop: { name: string; driveSeconds: number | null } | null;
  position: TechnicianPosition;
  track: readonly MotionSample[];
}) {
  const now = useNow(1_000);
  const motion = motionOf(track, now);
  const paused = isLocationPaused(position, now);
  // Nothing old is presented as current: a speed from a fix minutes ago is a
  // claim about the past dressed as the present.
  const current = Boolean(motion?.live) && !paused;
  const kmh = current ? speedKmh(motion?.speedMetersPerSecond ?? null) : null;
  const heading = current ? (motion?.headingDegrees ?? null) : null;
  const { label, tone } = describeMotion(motion, { paused, now });
  const name = position.technician?.displayName ?? 'Unknown technician';
  // Why the marker may not be telling the whole story, in the phone's own
  // words -- the reason a stalled marker used to arrive without.
  const problem = trackingProblem(position.tracking);
  const phone = trackingSummary(position.tracking);

  return (
    <div
      {...overlay}
      aria-label={`${name}: ${label}${problem ? `. ${problem.message}` : ''}`}
      className="bg-popover text-popover-foreground mx-2.5 mb-2 flex max-w-[calc(100vw-2rem)] flex-col overflow-hidden rounded-xl border shadow-lg"
      role="group"
      title={phone ?? undefined}
    >
      <div className="flex items-stretch divide-x">
      <Cell className="pr-4">
        <div
          className={cn(
            'flex size-14 shrink-0 flex-col items-center justify-center rounded-full border-[3px]',
            current && motion?.state === 'DRIVING' ? 'border-map-technician' : 'border-border',
          )}
        >
          <span className="font-mono text-xl leading-none font-semibold tabular-nums">
            {kmh ?? '–'}
          </span>
          <span className="text-muted-foreground mt-0.5 text-[10px] leading-none font-medium">
            km/h
          </span>
        </div>
        {/* Said, rather than implied by a smaller number: a speed read off
            two positions is an estimate, and a dispatcher deciding whether
            somebody was speeding deserves to know which kind they are
            looking at. */}
        {current && motion?.source === 'TRAIL' && kmh ? (
          <span className="text-muted-foreground text-[11px] leading-tight">
            estimated
            <br />
            from trail
          </span>
        ) : null}
      </Cell>

      <Cell>
        <HeadingNeedle heading={heading} />
        <div className="flex flex-col leading-tight">
          <span className="text-sm font-semibold">{heading === null ? '–' : formatCompass(heading)}</span>
          <span className="text-muted-foreground font-mono text-xs tabular-nums">
            {heading === null ? 'Heading' : `${Math.round(heading)}°`}
          </span>
        </div>
      </Cell>

      <Cell className="min-w-[9rem]">
        <div className="flex min-w-0 flex-col leading-tight">
          <span className="flex items-center gap-1.5 text-sm font-semibold">
            <span
              aria-hidden
              className={cn(
                'inline-block size-2 shrink-0 rounded-full',
                tone === 'live' && 'bg-map-technician',
                tone === 'quiet' && 'bg-map-technician-stale',
                tone === 'warning' && 'bg-warning',
              )}
            />
            {label}
          </span>
          <span className="text-muted-foreground truncate text-xs">
            {name}
            {motion ? <> · {formatAge(now - motion.recordedAt)}</> : null}
          </span>
        </div>
      </Cell>

      {nextStop ? (
        // Dropped first when the map is narrow: it is also in the list beside
        // the map, and speed and heading are not.
        <Cell className="hidden max-w-[16rem] md:flex">
          <div className="flex min-w-0 flex-col leading-tight">
            <span className="text-muted-foreground text-[11px] font-medium tracking-wide uppercase">
              Next stop
            </span>
            <span className="truncate text-sm font-medium">{nextStop.name}</span>
            {nextStop.driveSeconds === null ? null : (
              <span className="text-muted-foreground font-mono text-xs tabular-nums">
                {formatDuration(nextStop.driveSeconds)} drive
              </span>
            )}
          </div>
        </Cell>
      ) : null}
      </div>

      {problem ? (
        <div className="flex items-start gap-2 border-t px-3.5 py-2 text-xs leading-snug">
          {problem.tone === 'warning' ? (
            <TriangleAlertIcon aria-hidden className="text-warning mt-px size-3.5 shrink-0" />
          ) : (
            <InfoIcon aria-hidden className="text-muted-foreground mt-px size-3.5 shrink-0" />
          )}
          <span>{problem.message}</span>
        </div>
      ) : null}
    </div>
  );
}

/**
 * Hand the camera back to the map.
 *
 * Always shown, and labelled: a bare target icon in a corner of a map full of
 * small icons is a control nobody finds, which this console has shipped once
 * already. It says "Following" while the map is following somebody, so the
 * reader can tell the map is moving on its own rather than drifting, and turns
 * primary once they have moved the map themselves -- the moment it is needed.
 */
export function RecenterControl({
  following,
  onRecenter,
  readerMoved,
  subject,
}: {
  /** A technician is focused, so centring on them means following them. */
  following: boolean;
  onRecenter: () => void;
  readerMoved: boolean;
  /** Who or what it centres on, for the accessible name. */
  subject: string;
}) {
  const isFollowing = following && !readerMoved;
  return (
    <div {...overlay} className="m-2.5">
      <Button
        aria-label={isFollowing ? `Following ${subject}. Re-center` : `Re-center on ${subject}`}
        className="shadow-md"
        onClick={onRecenter}
        size="sm"
        variant={readerMoved ? 'default' : 'secondary'}
      >
        {isFollowing ? <LocateFixedIcon className="text-map-technician" /> : <LocateIcon />}
        {isFollowing ? 'Following' : 'Re-center'}
      </Button>
    </div>
  );
}
