'use client';

import type {
  ComparisonChecklistRowView,
  ComparisonFindingView,
  ComparisonRoomView,
  ComparisonSideView,
  ComparisonView,
  ReportPhotoView,
  ReportTone,
} from '@texasrenters/shared';
import { comparisonItemList } from '@texasrenters/shared';
import Image from 'next/image';
import type { ReactNode } from 'react';

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
 * the preview cannot disagree. Like the inspection report, colour arrives as
 * data -- the tones are shared with the PDF -- and is applied inline; it is an
 * accent on a word, never the message.
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

function Chip({ tone, children }: { tone: ReportTone; children: ReactNode }) {
  return (
    <span
      className="inline-flex shrink-0 items-center rounded-md border px-2 py-0.5 text-xs font-medium whitespace-nowrap"
      style={{ color: tone.accent, background: tone.surface, borderColor: tone.border }}
    >
      {children}
    </span>
  );
}

function Finding({ finding }: { finding: ComparisonFindingView }) {
  return (
    <li
      className="bg-card space-y-1 rounded-r-lg border-l-4 py-2 pr-3 pl-3"
      style={{ borderLeftColor: finding.tone.accent }}
    >
      <div className="flex flex-wrap items-start justify-between gap-2">
        <p className="text-sm font-medium">{finding.title}</p>
        <Chip tone={finding.tone}>{finding.severityLabel}</Chip>
      </div>
      <p className="text-muted-foreground text-xs leading-relaxed">{finding.description}</p>
    </li>
  );
}

/** One verdict cell: "Y", "N", or blank -- read aloud as "Not assessed". */
function Axis({ value }: { value: string }) {
  return (
    <TableCell
      aria-label={value || 'Not assessed'}
      className={cn(
        'py-2 text-center align-top font-semibold',
        value === 'Y' && 'text-success',
        value === 'N' && 'text-destructive',
      )}
    >
      {value}
    </TableCell>
  );
}

/** A side's own checklist, for a room the two inspections could not compare item by item. */
function SideChecklist({ rows }: { rows: ComparisonChecklistRowView[] }) {
  if (!rows.length) return <p className="text-muted-foreground text-xs">No condition was graded.</p>;
  return (
    <div className="overflow-hidden rounded-lg border">
      <Table className="table-fixed">
        <colgroup>
          <col className="w-[52%]" />
          <col className="w-[16%]" />
          <col className="w-[16%]" />
          <col className="w-[16%]" />
        </colgroup>
        <TableHeader className="bg-muted lg:static print:table-header-group">
          <TableRow className="hover:bg-transparent">
            <TableHead scope="col">Item</TableHead>
            <TableHead className="text-center" scope="col" title="Clean">
              Clean
            </TableHead>
            <TableHead className="text-center" scope="col" title="Undamaged">
              Undam.
            </TableHead>
            <TableHead className="text-center" scope="col" title="Working">
              Work.
            </TableHead>
          </TableRow>
        </TableHeader>
        <TableBody>
          {rows.map((row) => (
            <TableRow className="print:break-inside-avoid" key={row.id}>
              <TableHead
                className="text-foreground h-auto py-2 align-top text-xs font-medium whitespace-normal"
                scope="row"
              >
                {row.label}
                {row.comment ? (
                  <span className="text-muted-foreground mt-0.5 block font-normal">{row.comment}</span>
                ) : null}
              </TableHead>
              <Axis value={row.clean} />
              <Axis value={row.undamaged} />
              <Axis value={row.working} />
            </TableRow>
          ))}
        </TableBody>
      </Table>
    </div>
  );
}

/** One inspection's photographs and approved findings for the room. */
function Side({
  room,
  side,
  which,
  renderPhoto,
  showChecklist,
}: {
  room: ComparisonRoomView;
  side: ComparisonSideView;
  which: 'move-in' | 'move-out';
  renderPhoto: ComparisonPhotoRenderer;
  showChecklist: boolean;
}) {
  const heading = which === 'move-in' ? 'At move-in' : 'At move-out';
  return (
    <div className="min-w-0 space-y-3">
      <h4 className="text-muted-foreground text-xs font-medium tracking-wide uppercase">
        {heading}
        {/* A room paired with a differently named one shows each name, so the
            pairing can be checked rather than taken on trust. */}
        {side.present && side.renamed ? (
          <span className="text-foreground normal-case"> · {side.name}</span>
        ) : null}
      </h4>
      {!side.present ? (
        <p className="text-muted-foreground rounded-lg border border-dashed p-3 text-sm">
          {side.statusLabel}.
        </p>
      ) : side.skipped && !side.photos.length ? (
        // Skipped on the day: the reason is the whole record, said once.
        <p className="text-muted-foreground rounded-lg border border-dashed p-3 text-sm">
          {side.statusLabel}
          {side.skipReason ? `: ${side.skipReason}` : '.'}
        </p>
      ) : (
        <>
          {side.skipReason ? (
            <p className="text-muted-foreground text-sm">
              {side.statusLabel}: {side.skipReason}
            </p>
          ) : null}
          {showChecklist ? <SideChecklist rows={side.checklist} /> : null}
          {side.photos.length ? (
            <div className="grid grid-cols-2 gap-2 sm:grid-cols-3">
              {side.photos.map((photo, index) => (
                <div className="print:break-inside-avoid" key={photo.id}>
                  {renderPhoto(photo, { roomName: room.name, side: which, photos: side.photos, index })}
                </div>
              ))}
            </div>
          ) : (
            <p className="text-muted-foreground text-xs">No photographs.</p>
          )}
          {side.findings.length ? (
            <ul className="grid gap-2">
              {side.findings.map((finding) => (
                <Finding finding={finding} key={finding.id} />
              ))}
            </ul>
          ) : null}
        </>
      )}
    </div>
  );
}

function Room({ room, renderPhoto }: { room: ComparisonRoomView; renderPhoto: ComparisonPhotoRenderer }) {
  return (
    <section
      aria-labelledby={`room-${room.id}`}
      className="bg-card space-y-4 rounded-xl border p-5 print:break-inside-avoid"
    >
      <header className="space-y-1.5">
        <div className="flex flex-wrap items-start justify-between gap-2">
          <div>
            <h3 className="font-semibold tracking-wide uppercase" id={`room-${room.id}`}>
              {room.name}
            </h3>
            {room.floorName ? <p className="text-muted-foreground text-xs">{room.floorName}</p> : null}
          </div>
          <Chip tone={room.tone}>{room.verdict}</Chip>
        </div>
        {room.sentence ? <p className="text-sm leading-relaxed">{room.sentence}</p> : null}
      </header>

      {room.items.length ? (
        <div className="overflow-x-auto rounded-lg border">
          <Table aria-label={`${room.name}: each item at move-in and at move-out`}>
            <TableHeader className="bg-muted lg:static print:table-header-group">
              <TableRow className="hover:bg-transparent">
                <TableHead scope="col">Item</TableHead>
                <TableHead scope="col">At move-in</TableHead>
                <TableHead scope="col">At move-out</TableHead>
                <TableHead scope="col">Change</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {room.items.map((item) => (
                <TableRow
                  className={cn('print:break-inside-avoid', item.quiet && 'text-muted-foreground')}
                  key={item.id}
                >
                  <TableHead
                    className="text-foreground h-auto py-2.5 align-top text-xs font-medium tracking-wide whitespace-normal uppercase"
                    scope="row"
                  >
                    {item.label}
                  </TableHead>
                  <TableCell className="py-2.5 align-top text-sm whitespace-normal">
                    {item.moveIn}
                    {item.moveInComment ? (
                      <span className="text-muted-foreground block text-xs italic">{item.moveInComment}</span>
                    ) : null}
                  </TableCell>
                  <TableCell className="py-2.5 align-top text-sm whitespace-normal">
                    {item.moveOut}
                    {item.moveOutComment ? (
                      <span className="text-muted-foreground block text-xs italic">{item.moveOutComment}</span>
                    ) : null}
                  </TableCell>
                  <TableCell className="py-2.5 align-top">
                    <div className="flex flex-wrap gap-1">
                      <Chip tone={item.changeTone}>{item.change}</Chip>
                      {item.cleaning ? <Chip tone={item.cleaningTone}>{item.cleaning}</Chip> : null}
                    </div>
                  </TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        </div>
      ) : null}

      <div className="grid gap-5 md:grid-cols-2">
        <Side renderPhoto={renderPhoto} room={room} showChecklist={!room.items.length} side={room.moveIn} which="move-in" />
        <div className="md:border-l md:pl-5">
          <Side
            renderPhoto={renderPhoto}
            room={room}
            showChecklist={!room.items.length}
            side={room.moveOut}
            which="move-out"
          />
        </div>
      </div>
    </section>
  );
}

/**
 * The document. `actions` sit in the header (the public page's "Download PDF");
 * `banner` above everything (the console's "not shared yet").
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
              ['Move-in', view.moveIn],
              ['Move-out', view.moveOut],
            ] as const
          ).map(([label, side]) => (
            <div className="space-y-0.5" key={label}>
              <dt className="text-muted-foreground text-xs font-medium">{label}</dt>
              <dd className="text-sm font-medium">{side.label}</dd>
              <dd className="text-muted-foreground text-sm">{side.date}</dd>
              {side.inspector ? (
                <dd className="text-muted-foreground text-sm">Inspector: {side.inspector}</dd>
              ) : null}
            </div>
          ))}
        </dl>
      </header>

      <section className="space-y-3">
        <h2 className="text-lg font-semibold tracking-tight">At a glance</h2>
        <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
          {view.stats.map((stat) => (
            <div className="bg-card rounded-xl border p-4" key={stat.label}>
              <p className="text-2xl font-semibold tabular-nums" style={{ color: stat.tone.accent }}>
                {stat.value}
              </p>
              <p className="text-muted-foreground mt-0.5 text-xs">{stat.label}</p>
            </div>
          ))}
        </div>
      </section>

      <section className="space-y-3">
        <h2 className="text-lg font-semibold tracking-tight">Summary</h2>
        <div className="bg-card space-y-4 rounded-xl border p-5">
          <p className="font-medium">{view.headline}.</p>
          {view.newDamage.length ? (
            <div className="space-y-1.5">
              <h3 className="text-muted-foreground text-xs font-medium tracking-wide uppercase">
                New since move-in
              </h3>
              <ul className="grid gap-1 text-sm">
                {view.newDamage.map((room) => (
                  <li key={room.id}>
                    <a className="font-medium underline-offset-4 hover:underline" href={`#room-${room.id}`}>
                      {room.name}
                    </a>
                    {room.items.length ? (
                      <span className="text-muted-foreground"> — {comparisonItemList(room.items)}</span>
                    ) : null}
                  </li>
                ))}
              </ul>
            </div>
          ) : null}
          {view.cleaning.length ? (
            <div className="space-y-1.5">
              <h3 className="text-muted-foreground text-xs font-medium tracking-wide uppercase">
                Needs cleaning
              </h3>
              <ul className="grid gap-1 text-sm">
                {view.cleaning.map((room) => (
                  <li key={room.id}>
                    <a className="font-medium underline-offset-4 hover:underline" href={`#room-${room.id}`}>
                      {room.name}
                    </a>
                    <span className="text-muted-foreground"> — {comparisonItemList(room.items)}</span>
                  </li>
                ))}
              </ul>
            </div>
          ) : null}
        </div>
      </section>

      <section className="space-y-3">
        <h2 className="text-lg font-semibold tracking-tight">Room by room</h2>
        <div className="grid gap-4">
          {view.rooms.map((room) => (
            <Room key={room.id} renderPhoto={renderPhoto} room={room} />
          ))}
        </div>
      </section>

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
