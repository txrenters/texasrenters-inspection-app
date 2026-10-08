'use client';

import type {
  ComparisonChecklistRowView,
  ComparisonFindingView,
  ComparisonMark,
  ComparisonMarkKind,
  ComparisonRoomView,
  ComparisonSideView,
  ComparisonToneName,
  ComparisonUncomparedRoomView,
  ComparisonView,
  ReportPhotoView,
} from '@texasrenters/shared';
import { COMPARISON_PHOTO_PREVIEW } from '@texasrenters/shared';
import { ChevronRightIcon } from 'lucide-react';
import Image from 'next/image';
import type { ReactNode } from 'react';
import { useState } from 'react';

import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '@/components/ui/table';
import { cn } from '@/lib/utils';

/**
 * The move-in / move-out comparison as a document: what an owner or tenant
 * opens from a share link, and what the console previews before one is sent.
 *
 * Presentation only. Every word and every verdict comes from the shared
 * `buildComparisonView`, which the PDF renders too, so the page, the PDF and
 * the preview cannot disagree.
 *
 * Read by people who do not inspect houses (2026-10-09): what was found comes
 * first, every grade is one of four signs -- an icon and a word, coloured by
 * the theme's status tokens so it reads in both modes -- and each room shows
 * only what changed, with the rest a click away.
 *
 * The one thing the caller supplies is how a photograph is shown: the console
 * fetches bytes with its session and opens its zooming viewer, a share link
 * points an `<img>` at the token's photo route.
 */

/** Which side of the comparison a photograph belongs to, for the viewer's heading. */
export interface ComparisonPhotoContext {
  roomName: string;
  side: 'move-in' | 'move-out';
  photos: ReportPhotoView[];
  index: number;
}

export type ComparisonPhotoRenderer = (
  photo: ReportPhotoView,
  context: ComparisonPhotoContext,
) => ReactNode;

const MARK_CLASS: Record<ComparisonMarkKind, string> = {
  good: 'text-success',
  damaged: 'text-destructive',
  dirty: 'text-warning',
  none: 'text-muted-foreground',
};

const TONE_BADGE: Record<ComparisonToneName, 'destructive' | 'success' | 'warning' | 'secondary'> = {
  damage: 'destructive',
  sound: 'success',
  cleaning: 'warning',
  neutral: 'secondary',
};

/** The sign itself: a tinted disc with a tick, a cross, a half-fill or a dash. */
function MarkIcon({ kind, className }: { kind: ComparisonMarkKind; className?: string }) {
  const stroke = {
    fill: 'none',
    stroke: 'currentColor',
    strokeWidth: 1.8,
    strokeLinecap: 'round' as const,
    strokeLinejoin: 'round' as const,
  };
  return (
    <svg
      aria-hidden="true"
      className={cn('size-4 shrink-0', MARK_CLASS[kind], className)}
      focusable="false"
      viewBox="0 0 16 16"
    >
      <circle cx="8" cy="8" fill="currentColor" opacity={0.14} r="7.25" />
      {kind === 'good' ? <path d="M4.8 8.4l2.1 2.1 4.3-4.7" {...stroke} /> : null}
      {kind === 'damaged' ? <path d="M5.6 5.6l4.8 4.8M10.4 5.6l-4.8 4.8" {...stroke} /> : null}
      {kind === 'dirty' ? (
        <>
          <circle cx="8" cy="8" fill="none" r="4.2" stroke="currentColor" strokeWidth={1.6} />
          <path d="M8 3.8a4.2 4.2 0 0 1 0 8.4z" fill="currentColor" />
        </>
      ) : null}
      {kind === 'none' ? <path d="M5.2 8h5.6" {...stroke} /> : null}
    </svg>
  );
}

function Mark({ mark }: { mark: ComparisonMark }) {
  return (
    <span
      className={cn(
        'inline-flex items-center gap-1 whitespace-nowrap',
        mark.kind === 'none' ? 'text-muted-foreground' : cn('font-medium', MARK_CLASS[mark.kind]),
      )}
    >
      <MarkIcon kind={mark.kind} />
      {mark.label}
    </span>
  );
}

function Marks({ marks, comment }: { marks: ComparisonMark[]; comment?: string | null }) {
  return (
    <div className="space-y-0.5">
      <div className="flex flex-wrap gap-x-3 gap-y-0.5">
        {marks.map((mark) => (
          <Mark key={`${mark.kind}-${mark.label}`} mark={mark} />
        ))}
      </div>
      {comment ? <p className="text-muted-foreground text-xs italic">{comment}</p> : null}
    </div>
  );
}

/** A small text button that shows or hides more of a room. */
function MoreButton({
  children,
  onClick,
  expanded,
}: {
  children: ReactNode;
  onClick: () => void;
  expanded: boolean;
}) {
  return (
    <Button
      aria-expanded={expanded}
      className="h-auto px-0 py-0 print:hidden"
      onClick={onClick}
      size="sm"
      type="button"
      variant="link"
    >
      {children}
    </Button>
  );
}

/** One side's photographs: the first few, the rest on request. */
function Photos({
  roomName,
  side,
  which,
  renderPhoto,
}: {
  roomName: string;
  side: ComparisonSideView;
  which: 'move-in' | 'move-out';
  renderPhoto: ComparisonPhotoRenderer;
}) {
  const [all, setAll] = useState(false);
  const shown = all ? side.photos : side.photos.slice(0, COMPARISON_PHOTO_PREVIEW);
  return (
    <div className="min-w-0 space-y-2">
      <h4 className="text-sm font-medium">
        {which === 'move-in' ? 'Move-in photos' : 'Move-out photos'}{' '}
        <span className="text-muted-foreground font-normal tabular-nums">({side.photos.length})</span>
      </h4>
      {side.photos.length ? (
        <div className="grid grid-cols-2 gap-2">
          {shown.map((photo, index) => (
            <div className="print:break-inside-avoid" key={photo.id}>
              {renderPhoto(photo, { roomName, side: which, photos: side.photos, index })}
            </div>
          ))}
        </div>
      ) : (
        <p className="text-muted-foreground text-sm">No photographs.</p>
      )}
      {side.photos.length > COMPARISON_PHOTO_PREVIEW ? (
        <MoreButton expanded={all} onClick={() => setAll(!all)}>
          {all ? 'Show fewer' : `Show all ${side.photos.length}`}
        </MoreButton>
      ) : null}
    </div>
  );
}

const NOTES_SHOWN = 5;

/** Notes the office confirmed: a title and how serious, the first few. */
function Notes({ heading, findings }: { heading: string; findings: ComparisonFindingView[] }) {
  const [all, setAll] = useState(false);
  if (!findings.length) return null;
  const shown = all ? findings : findings.slice(0, NOTES_SHOWN);
  return (
    <div className="space-y-2">
      <h4 className="text-muted-foreground text-xs font-medium tracking-wide uppercase">{heading}</h4>
      <ul className="divide-y border-y">
        {shown.map((finding) => (
          <li className="flex items-start justify-between gap-3 py-2 print:break-inside-avoid" key={finding.id}>
            <div className="min-w-0">
              <p className="text-sm font-medium">{finding.title}</p>
              {finding.description ? (
                <p className="text-muted-foreground text-xs leading-relaxed">{finding.description}</p>
              ) : null}
            </div>
            <Badge variant={TONE_BADGE[finding.toneName]}>{finding.severityLabel}</Badge>
          </li>
        ))}
      </ul>
      {findings.length > NOTES_SHOWN ? (
        <MoreButton expanded={all} onClick={() => setAll(!all)}>
          {all ? 'Show fewer' : `Show ${findings.length - NOTES_SHOWN} more`}
        </MoreButton>
      ) : null}
    </div>
  );
}

/** A side's own graded rows, for a room not compared item by item. */
function Recorded({ heading, rows }: { heading: string; rows: ComparisonChecklistRowView[] }) {
  return (
    <div className="min-w-0 space-y-2">
      <h4 className="text-sm font-medium">{heading}</h4>
      {rows.length ? (
        <ul className="divide-y border-y text-sm">
          {rows.map((row) => (
            <li className="flex flex-wrap items-start justify-between gap-x-3 gap-y-1 py-1.5" key={row.id}>
              <span className="font-medium">{row.label}</span>
              <Marks comment={row.comment} marks={row.marks} />
            </li>
          ))}
        </ul>
      ) : (
        <p className="text-muted-foreground text-sm">Nothing graded.</p>
      )}
    </div>
  );
}

function Room({ room, renderPhoto }: { room: ComparisonRoomView; renderPhoto: ComparisonPhotoRenderer }) {
  const [unfolded, setUnfolded] = useState(false);
  const rows = room.items.filter((item) => unfolded || item.changed);
  const recorded =
    !room.items.length && (room.moveIn.checklist.length > 0 || room.moveOut.checklist.length > 0);
  return (
    <section
      aria-labelledby={`room-${room.id}`}
      className="bg-card scroll-mt-20 overflow-hidden rounded-xl border print:break-inside-avoid"
      id={`room-${room.id}-card`}
    >
      <header className="space-y-1.5 border-b p-4 sm:p-5">
        <div className="flex flex-wrap items-start justify-between gap-2">
          <div className="min-w-0">
            <h3 className="text-lg font-semibold tracking-tight" id={`room-${room.id}`}>
              {room.name}
            </h3>
            {room.floorName ? <p className="text-muted-foreground text-xs">{room.floorName}</p> : null}
          </div>
          <Badge className="gap-1" variant={TONE_BADGE[room.toneName]}>
            <MarkIcon className="text-current" kind={room.mark} />
            {room.verdict}
          </Badge>
        </div>
        {/* A room paired with a differently named one says so, so the pairing
            can be checked rather than taken on trust. */}
        {room.moveIn.present && room.moveIn.renamed ? (
          <p className="text-muted-foreground text-xs">
            Compared with the move-in&apos;s &ldquo;{room.moveIn.name}&rdquo;
          </p>
        ) : null}
        {room.sentence ? <p className="text-sm leading-relaxed text-pretty">{room.sentence}</p> : null}
      </header>

      <div className="space-y-5 p-4 sm:p-5">
        {rows.length ? (
          <div className="overflow-x-auto rounded-lg border">
            <Table aria-label={`${room.name}: each item at move-in and at move-out`}>
              <TableHeader className="bg-muted max-sm:hidden lg:static print:table-header-group">
                <TableRow className="hover:bg-transparent">
                  <TableHead className="w-[40%]" scope="col">
                    Item
                  </TableHead>
                  <TableHead scope="col">Move-in</TableHead>
                  <TableHead scope="col">Move-out</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {rows.map((item) => (
                  // On a phone each item is a small card: its name, then the two sides.
                  <TableRow
                    className={cn(
                      'max-sm:grid max-sm:grid-cols-2 max-sm:gap-x-3 max-sm:py-1 print:break-inside-avoid',
                      !item.changed && 'text-muted-foreground',
                    )}
                    key={item.id}
                  >
                    <TableHead
                      className="text-foreground h-auto py-2.5 align-top whitespace-normal max-sm:col-span-2 max-sm:pb-1"
                      scope="row"
                    >
                      <span className="block text-sm font-medium">{item.label}</span>
                      {item.result ? (
                        <Badge className="mt-1" variant={TONE_BADGE[item.result.toneName]}>
                          {item.result.label}
                        </Badge>
                      ) : item.needsCleaning ? (
                        <Badge className="mt-1" variant="warning">
                          Needs cleaning
                        </Badge>
                      ) : null}
                    </TableHead>
                    <TableCell className="py-2.5 align-top text-sm whitespace-normal max-sm:pt-0">
                      <span className="text-muted-foreground block text-xs sm:hidden">Move-in</span>
                      <Marks comment={item.moveIn.comment} marks={item.moveIn.marks} />
                    </TableCell>
                    <TableCell className="py-2.5 align-top text-sm whitespace-normal max-sm:pt-0">
                      <span className="text-muted-foreground block text-xs sm:hidden">Move-out</span>
                      <Marks comment={item.moveOut.comment} marks={item.moveOut.marks} />
                    </TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          </div>
        ) : null}

        {room.folded ? (
          <p className="text-muted-foreground text-sm">
            {unfolded ? null : (
              <>
                {room.foldedCount} other {room.foldedCount === 1 ? 'item' : 'items'}: {room.folded}{' '}
              </>
            )}
            <MoreButton expanded={unfolded} onClick={() => setUnfolded(!unfolded)}>
              {unfolded ? 'Show only what changed' : 'Show them'}
            </MoreButton>
          </p>
        ) : null}

        {recorded ? (
          <div className="grid gap-5 md:grid-cols-2">
            <Recorded heading="Recorded at move-in" rows={room.moveIn.checklist} />
            <Recorded heading="Recorded at move-out" rows={room.moveOut.checklist} />
          </div>
        ) : null}

        <Notes findings={room.moveOut.findings} heading="Noted at move-out, confirmed by our team" />
        <Notes findings={room.moveIn.findings} heading="Noted at move-in" />

        <div className="grid gap-5 md:grid-cols-2">
          <Photos renderPhoto={renderPhoto} roomName={room.name} side={room.moveIn} which="move-in" />
          <div className="md:border-l md:pl-5">
            <Photos renderPhoto={renderPhoto} roomName={room.name} side={room.moveOut} which="move-out" />
          </div>
        </div>
      </div>
    </section>
  );
}

/** A room the two inspections do not share: a line, and what was recorded on request. */
function UncomparedRoom({
  room,
  renderPhoto,
}: {
  room: ComparisonUncomparedRoomView;
  renderPhoto: ComparisonPhotoRenderer;
}) {
  const [open, setOpen] = useState(false);
  const which = room.recordedAt === 'Move-in' ? 'move-in' : 'move-out';
  return (
    <li className="print:break-inside-avoid">
      <button
        aria-expanded={open}
        className="hover:bg-muted/50 focus-visible:ring-ring/50 grid w-full grid-cols-[1rem_minmax(0,1fr)_auto] items-start gap-x-3 px-3 py-2.5 text-left text-sm focus-visible:ring-[3px] focus-visible:outline-none"
        onClick={() => setOpen(!open)}
        type="button"
      >
        <ChevronRightIcon
          aria-hidden="true"
          className={cn(
            'text-muted-foreground mt-0.5 size-4 transition-transform print:hidden',
            open && 'rotate-90',
          )}
        />
        <span className="min-w-0">
          <span className="block font-medium">{room.name}</span>
          <span className="text-muted-foreground block text-xs">{room.reason}</span>
        </span>
        <span className="flex items-center justify-end gap-1 text-right">
          <MarkIcon kind={room.mark} />
          <span className={cn(room.mark === 'none' && 'text-muted-foreground')}>
            {room.recordedAt}: {room.recorded}
          </span>
        </span>
      </button>
      {open ? (
        <div className="grid gap-5 px-3 pb-4 sm:pl-10 md:grid-cols-2">
          <Recorded heading={`Recorded at ${which}`} rows={room.side.checklist} />
          <Photos renderPhoto={renderPhoto} roomName={room.name} side={room.side} which={which} />
        </div>
      ) : null}
    </li>
  );
}

/**
 * The document. `actions` sit in the header (the public page's "Download PDF");
 * `banner` above everything (the console's "still to come").
 */
export function ComparisonDocument({
  view,
  renderPhoto,
  actions,
  banner,
}: {
  view: ComparisonView;
  renderPhoto: ComparisonPhotoRenderer;
  actions?: ReactNode;
  banner?: ReactNode;
}) {
  return (
    <article className="space-y-8">
      {banner}
      <header className="bg-card space-y-4 rounded-xl border p-6 sm:p-8">
        <div className="flex flex-wrap items-start justify-between gap-4">
          <div className="min-w-0 space-y-1">
            <Image
              alt={view.brand.name}
              className="mb-3 h-6 w-auto dark:brightness-0 dark:invert"
              height={167}
              priority
              src="/texasrenterslogo-transparent.png"
              width={600}
            />
            <p className="text-muted-foreground text-xs font-medium tracking-wide uppercase">
              {view.kicker}
            </p>
            <h1 className="text-2xl font-semibold tracking-tight text-balance">{view.title}</h1>
            {view.subtitle ? <p className="text-muted-foreground text-sm">{view.subtitle}</p> : null}
          </div>
          {actions}
        </div>

        {/* Move-in left, move-out right: the order every room below keeps. */}
        <dl className="grid gap-4 border-t pt-4 sm:grid-cols-2">
          {(
            [
              ['Move-in inspection', view.moveIn],
              ['Move-out inspection', view.moveOut],
            ] as const
          ).map(([label, side]) => (
            <div className="space-y-0.5" key={label}>
              <dt className="text-muted-foreground text-xs font-medium">{label}</dt>
              <dd className="text-sm font-medium">{side.date}</dd>
              <dd className="text-muted-foreground text-sm">
                {[side.label, side.inspector ? `Inspector: ${side.inspector}` : null]
                  .filter(Boolean)
                  .join(' · ')}
              </dd>
            </div>
          ))}
        </dl>
      </header>

      {/* The answer first: what a reader opened the report to learn. */}
      <section
        aria-labelledby="comparison-found"
        className="bg-card border-foreground/70 space-y-3 rounded-xl border-2 p-5 sm:p-6"
      >
        <h2 className="text-lg font-semibold tracking-tight" id="comparison-found">
          What we found
        </h2>
        <ul className="space-y-2.5">
          {view.found.map((line) => (
            <li className="grid grid-cols-[1.25rem_minmax(0,1fr)] gap-2.5 leading-relaxed" key={line.lead}>
              <MarkIcon className="mt-0.5 size-5" kind={line.mark} />
              <p>
                <strong className="font-semibold">{line.lead}</strong> {line.detail}
              </p>
            </li>
          ))}
        </ul>
      </section>

      <p className="bg-muted/60 flex flex-wrap items-center gap-x-4 gap-y-1.5 rounded-lg px-4 py-2.5 text-sm">
        <span className="font-medium">How to read this report:</span>
        {view.key.map((mark) => (
          <Mark key={mark.kind} mark={mark} />
        ))}
      </p>

      {view.rooms.length ? (
        <section aria-labelledby="comparison-rooms" className="space-y-3">
          <h2 className="text-lg font-semibold tracking-tight" id="comparison-rooms">
            Room by room
          </h2>
          {/* The rooms at a glance, and the way to each. */}
          <ol className="bg-card divide-y rounded-xl border">
            {view.rooms.map((room) => (
              <li key={room.id}>
                <a
                  className="hover:bg-muted/50 focus-visible:ring-ring/50 grid grid-cols-[1.25rem_minmax(0,1fr)_auto] items-center gap-3 px-4 py-2.5 text-sm focus-visible:ring-[3px] focus-visible:outline-none"
                  href={`#room-${room.id}-card`}
                >
                  <MarkIcon className="size-[18px]" kind={room.mark} />
                  <span className="font-medium">{room.name}</span>
                  <span className="text-muted-foreground text-right text-[13px]">{room.digest}</span>
                </a>
              </li>
            ))}
          </ol>
          <div className="grid gap-4 pt-2">
            {view.rooms.map((room) => (
              <Room key={room.id} renderPhoto={renderPhoto} room={room} />
            ))}
          </div>
        </section>
      ) : null}

      {view.uncompared.length ? (
        <section aria-labelledby="comparison-uncompared" className="space-y-3" id="not-compared">
          <div className="space-y-1">
            <h2 className="text-lg font-semibold tracking-tight" id="comparison-uncompared">
              Rooms we couldn&apos;t compare
            </h2>
            <p className="text-muted-foreground text-sm text-pretty">
              These rooms were recorded at only one of the two inspections, so there is nothing to
              compare them with. What that inspection recorded is shown for reference.
            </p>
          </div>
          <ul className="bg-card divide-y rounded-xl border">
            {view.uncompared.map((room) => (
              <UncomparedRoom key={room.id} renderPhoto={renderPhoto} room={room} />
            ))}
          </ul>
        </section>
      ) : null}

      <footer className="text-muted-foreground space-y-2 border-t pt-6 text-xs">
        <p className="text-pretty">{view.disclaimer}</p>
        <p>
          {[view.brand.name, view.brand.addressLine1, view.brand.addressLine2, view.brand.phone, view.brand.email]
            .filter(Boolean)
            .join(' · ')}
        </p>
        <p>Generated {view.generatedLabel}</p>
      </footer>
    </article>
  );
}
