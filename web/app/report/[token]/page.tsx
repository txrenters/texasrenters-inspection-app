'use client';

import { REPORT_TYPE, buildReportView } from '@texasrenters/shared';
import type { PublicInspectionReport, ReportRoomView } from '@texasrenters/shared';
import { DownloadIcon } from 'lucide-react';
import Image from 'next/image';
import { useParams } from 'next/navigation';
import { useEffect, useMemo, useState } from 'react';

import { ReportPhotoViewer } from '@/components/report-photo-viewer';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Skeleton } from '@/components/ui/skeleton';
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '@/components/ui/table';
import { ApiError, publicApi } from '@/lib/api';
import { cn } from '@/lib/utils';

/**
 * Homeowner-facing report. Presentation only: what appears, in what order, and
 * how it is worded comes from the shared `buildReportView`, which the PDF
 * renderer also consumes — see shared/src/report/report-view.ts.
 *
 * Each area prints its condition table and its photographs. What the room
 * needs, from the summary of its recordings, prints in the table's Comments
 * column beside the item it is about (the maintenance team, 2026-10-08); the
 * console keeps the summary's timestamped points and its Repairs / Painting /
 * Cleaning grouping. A photograph opens over the page. The findings cards and the summary of findings that
 * opened the report are gone at the same team's request.
 */

/**
 * Grid thumbnails, at the widths the backend caches (see ALLOWED_PHOTO_WIDTHS):
 * the browser picks the smaller copy where a photograph is small and the larger
 * on a sharp screen. Three a row on a wide page shows them about 310 px wide.
 */
const THUMB_WIDTH = 320;
const THUMB_WIDTH_SHARP = 640;
/** Two a row on a phone, three from 640 px up. */
const THUMB_SIZES = '(min-width: 640px) 320px, 50vw';
const FULL_WIDTH = 1000;

function photoUrl(contentPath: string, width: number) {
  const base = process.env.NEXT_PUBLIC_API_BASE_URL?.replace(/\/$/, '') ?? '';
  return `${base}${contentPath}?w=${width}`;
}

/**
 * One verdict cell.
 *
 * Colour is an accent, never the message: the letter carries the meaning in
 * print, in monochrome, and to a screen reader, which is told "Not assessed"
 * for the blank rather than reading silence.
 */
function AxisCell({ value }: { value: string }) {
  return (
    <TableCell
      aria-label={value || 'Not assessed'}
      // A box of its own, the letter in the middle of it (2026-10-08: "lines on
      // the Y and N, centred, so it is not scattered to look at").
      className={cn(
        'border-x px-1 py-2 text-center align-middle font-semibold',
        value === 'Y' ? 'text-success' : value === 'N' ? 'text-destructive' : '',
      )}
    >
      {value}
    </TableCell>
  );
}

function Room({ room }: { room: ReportRoomView }) {
  // An occupied room answers each question once. Heading it with three verdict
  // columns it never fills is what made its answers look missing.
  const answersOnly = room.checklist.every((row) => row.kind === 'ANSWER');
  // The photograph open over the page, or none (2026-10-08: not a new tab).
  const [viewing, setViewing] = useState<number | null>(null);
  return (
    // `print:break-inside-avoid`: a page break between a room's verdicts and
    // the photographs proving them is what makes a printed report hard to read.
    <section className="bg-card space-y-4 rounded-xl border p-5 print:break-inside-avoid">
      <header className="flex flex-wrap items-start justify-between gap-2">
        <div>
          {/* Uppercased in CSS rather than in the string, here and on the
              checklist labels below. The office's report sets area and item
              names in caps, but transforming the text keeps the real casing in
              the data and in the accessibility tree — a screen reader says
              "Bathroom" rather than spelling it out letter by letter, which is
              what it does with a hard-uppercased word. */}
          <h3 className="text-[1.15em] font-semibold tracking-wide uppercase">{room.name}</h3>
          {room.floorName ? (
            <p className="text-muted-foreground text-[0.8em]">{room.floorName}</p>
          ) : null}
        </div>
        <Badge appearance="pill" variant={room.inspected ? 'success' : 'secondary'}>{room.statusLabel}</Badge>
      </header>

      {/* The condition table, first in the room and before the photographs — the
          same order the office's printed reports use, because the table is the
          record and the photographs are its evidence.

          An empty cell means the technician did not assess that axis. It is
          deliberately blank rather than "N": the two are different claims, and
          printing "N" would publish a defect nobody observed. */}
      {room.checklist.length ? (
        <div className="overflow-hidden rounded-lg border">
          {/* Arial 13.5 throughout (the maintenance team, 2026-10-08: "Arial
              13.5, all of it"), headings, items, verdicts and comments alike. */}
          <Table className="table-fixed text-[1em] [&_thead_th]:text-[1em]">
            {/* `colgroup` rather than per-cell widths: `table-fixed` reads the
                first row to size the columns, so without it each room's table
                sizes itself from its own longest comment and no two line up
                down the page. The office's report prints one grid, not six.

                Tight verdict columns, as InspectCloud sets them, so the
                Comments column -- where what each item needs is printed --
                has the room (the maintenance team, 2026-10-08). */}
            <colgroup>
              <col className="w-[26%]" />
              <col className="w-[6%]" />
              <col className="w-[6%]" />
              <col className="w-[6%]" />
              <col className="w-[56%]" />
            </colgroup>
            {/* `static`, and an opaque background.
                `TableHeader` is sticky by default for the console's long list
                pages, which is wrong here twice over: this page has no app
                header to offset against and no scroll container, so the header
                detached and floated across the rows and the room heading above
                them. The translucent `bg-muted/40` it used to carry is what
                made that read as overlapping text rather than as a bar. */}
            <TableHeader className="bg-muted lg:static print:table-header-group">
              <TableRow className="hover:bg-transparent">
                <TableHead className="align-bottom" scope="col">
                  Room / item
                </TableHead>
                {answersOnly ? (
                  <TableHead className="align-bottom" colSpan={3} scope="col">
                    Condition
                  </TableHead>
                ) : (
                  // Slanted at 50 degrees, rising from the middle of their
                  // column over the Y and N beneath, as InspectCloud's are
                  // (the maintenance team, 2026-10-09), so three narrow
                  // columns still carry their whole names. On a phone the
                  // columns are too narrow for a slant -- the names would run
                  // into each other -- so there they stand upright.
                  //
                  // The column lines slant with them (2026-10-09: "slant the
                  // lines for that label too"): from each column's bottom
                  // corner up at the same 50 degrees, so each name sits in a
                  // slanted band of its own and the lines below carry on
                  // straight from where these start.
                  //
                  // Each name is anchored at its bottom-left and turned about
                  // it. With the lines a column apart, the band is the
                  // column's width times sin 50 across; the name -- one line,
                  // `leading-none`, 1em -- is centred in it when its corner
                  // sits (0.5em + its 0.45em lift x cos 50) / sin 50 = 1.03em
                  // right of the column's middle.
                  ['Clean', 'Undamaged', 'Working'].map((axis, index) => (
                    <TableHead
                      className="relative h-[6.1em] border-x p-0 align-bottom sm:h-[5.6em] sm:border-x-0"
                      key={axis}
                      scope="col"
                    >
                      <span
                        aria-hidden
                        className="bg-border pointer-events-none absolute bottom-0 left-0 hidden h-px w-[7.31em] origin-bottom-left -rotate-[50deg] sm:block"
                      />
                      {index === 2 ? (
                        <span
                          aria-hidden
                          className="bg-border pointer-events-none absolute bottom-0 left-full hidden h-px w-[7.31em] origin-bottom-left -rotate-[50deg] sm:block"
                        />
                      ) : null}
                      <span className="absolute bottom-[0.45em] left-[calc(50%+0.45em)] origin-bottom-left -rotate-90 leading-none whitespace-nowrap sm:left-[calc(50%+1.03em)] sm:-rotate-[50deg]">
                        {axis}
                      </span>
                    </TableHead>
                  ))
                )}
                {/* Centred in its wide column, as InspectCloud's is: at the
                    left it sat right where the last slanted line and
                    "Working" rise over it. */}
                <TableHead className="text-center align-bottom" scope="col">
                  Comments
                </TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {room.checklist.map((row) => (
                <TableRow className="print:break-inside-avoid" key={row.id}>
                  {/* Centred in its row: with the lines drawn round every cell
                      the row is a box of its own, so an item, its verdicts and
                      its comment read across it however many lines the
                      comment runs to. The item in capitals, as InspectCloud
                      sets it; the comment never (2026-10-08). */}
                  <TableHead
                    className="text-foreground h-auto py-2 align-middle text-[1em] font-medium tracking-wide whitespace-normal uppercase"
                    scope="row"
                  >
                    {row.label}
                  </TableHead>
                  {/* Spoken as "Not assessed" so a blank cell is not silence to a
                      screen reader — the distinction from "No" matters as much
                      aloud as it does in print. */}
                  {row.kind === 'ANSWER' ? (
                    // One answer where the three verdicts would be, so the
                    // Comments column still lines up down the page.
                    <TableCell className="border-x py-2 text-center align-middle font-semibold" colSpan={3}>
                      {row.answer}
                    </TableCell>
                  ) : (
                    <>
                      <AxisCell value={row.clean} />
                      <AxisCell value={row.undamaged} />
                      <AxisCell value={row.working} />
                    </>
                  )}
                  {/* The reviewer's comment, then what the room needs that is
                      about this item, from the summary of its recordings, one
                      line each -- in the sentence case it was written in. */}
                  <TableCell className="py-2 align-middle leading-snug whitespace-normal normal-case">
                    {row.comment ? <p className="text-muted-foreground">{row.comment}</p> : null}
                    {row.actions.map((action) => (
                      <p key={action}>{action}</p>
                    ))}
                  </TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        </div>
      ) : null}

      {/* Three a row at most (the maintenance team, 2026-10-08): four made
          each photograph too small to see what it shows. */}
      {room.photos.length ? (
        <div className="grid grid-cols-2 gap-3 sm:grid-cols-3">
          {room.photos.map((photo, index) => (
            <figure className="space-y-1.5 print:break-inside-avoid" key={photo.id}>
              {/* Opens over the page, not in a new tab (2026-10-08). */}
              <button
                aria-label={`Open ${photo.caption ?? `photograph ${index + 1}`} of ${room.name}`}
                className="focus-visible:ring-ring/50 relative block w-full cursor-zoom-in overflow-hidden rounded-lg border focus-visible:ring-[3px] focus-visible:outline-none"
                onClick={() => setViewing(index)}
                type="button"
              >
                {/* Plain <img>: these are token-scoped API URLs, not optimizable assets. */}
                {/* eslint-disable-next-line @next/next/no-img-element */}
                <img
                  alt={photo.caption ?? `Photo of ${room.name}`}
                  className="aspect-[4/3] w-full object-cover transition-transform hover:scale-105"
                  loading="lazy"
                  sizes={THUMB_SIZES}
                  src={photoUrl(photo.contentPath, THUMB_WIDTH_SHARP)}
                  srcSet={`${photoUrl(photo.contentPath, THUMB_WIDTH)} ${THUMB_WIDTH}w, ${photoUrl(photo.contentPath, THUMB_WIDTH_SHARP)} ${THUMB_WIDTH_SHARP}w`}
                />
                {/* On the photograph, as the office's timestamp-camera reports
                    print it, in Texas time with its zone. */}
                {photo.stamp ? (
                  <span className="pointer-events-none absolute bottom-1.5 left-1.5 rounded bg-black/65 px-1.5 py-0.5 text-[10px] font-medium text-white tabular-nums">
                    {photo.stamp}
                  </span>
                ) : null}
              </button>
              {photo.caption ? (
                <figcaption>
                  <p className="text-[0.85em] font-medium">{photo.caption}</p>
                </figcaption>
              ) : null}
            </figure>
          ))}
        </div>
      ) : null}

      <ReportPhotoViewer
        index={viewing}
        onClose={() => setViewing(null)}
        onIndexChange={setViewing}
        roomName={room.name}
        slides={room.photos.map((photo, index) => ({
          id: photo.id,
          src: photoUrl(photo.contentPath, FULL_WIDTH),
          alt: photo.caption ?? `Photograph ${index + 1} of ${room.name}`,
          caption: photo.caption,
          stamp: photo.stamp,
        }))}
      />

      {!room.hasEvidence ? (
        <p className="text-muted-foreground text-[1em]">
          {room.skipReason
            ? `Not inspected — ${room.skipReason}`
            : 'No issues were recorded for this room.'}
        </p>
      ) : null}
    </section>
  );
}

/**
 * Arial, running text at 13.5 pt (the maintenance team, 2026-10-08); every
 * size inside is relative to it, so this is the one place the size is set.
 * A little wider than before, so the condition table keeps its columns at the
 * larger size.
 */
function ReportShell({ children }: { children: React.ReactNode }) {
  return (
    <main
      className="bg-muted/40 min-h-dvh py-6 sm:py-10"
      style={{ fontFamily: REPORT_TYPE.fontStack, fontSize: `${REPORT_TYPE.bodyPt}pt` }}
    >
      <div className="mx-auto w-full max-w-5xl px-4">{children}</div>
    </main>
  );
}

export default function PublicReportPage() {
  const token = useParams<{ token: string }>().token;
  const [report, setReport] = useState<PublicInspectionReport | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!token) return;
    const controller = new AbortController();
    publicApi<PublicInspectionReport>(
      `/api/v1/reports/${encodeURIComponent(token)}`,
      controller.signal,
    )
      .then(setReport)
      .catch((cause) => {
        if (controller.signal.aborted) return;
        setError(
          cause instanceof ApiError && cause.status === 404
            ? 'This report link is invalid, expired, or has been revoked. Contact your property manager for a new link.'
            : 'The report could not be loaded right now. Please try again later.',
        );
      });
    return () => controller.abort();
  }, [token]);

  const view = useMemo(() => (report ? buildReportView(report) : null), [report]);

  if (error)
    return (
      <ReportShell>
        <div className="bg-card space-y-2 rounded-xl border p-8 text-center" role="alert">
          <h1 className="text-[1.5em] font-semibold tracking-tight">Report unavailable</h1>
          <p className="text-muted-foreground text-[1em] text-pretty">{error}</p>
        </div>
      </ReportShell>
    );

  if (!view)
    return (
      <ReportShell>
        <div aria-busy="true" className="bg-card space-y-6 rounded-xl border p-8" aria-live="polite">
          <div className="space-y-3">
            <Skeleton className="h-3 w-28" />
            <Skeleton className="h-8 w-2/3" />
            <Skeleton className="h-4 w-1/2" />
          </div>
          <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
            {Array.from({ length: 4 }, (_, index) => (
              <Skeleton className="h-20 rounded-lg" key={index} />
            ))}
          </div>
          <Skeleton className="h-40 rounded-lg" />
          <span className="sr-only">Loading your inspection report.</span>
        </div>
      </ReportShell>
    );

  const roomsWithEvidence = view.rooms.filter((room) => room.hasEvidence);
  const quietRooms = view.rooms.filter((room) => !room.hasEvidence);

  return (
    <ReportShell>
      <article className="space-y-8">
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
              <h1 className="text-[1.75em] leading-tight font-semibold tracking-tight text-balance">{view.title}</h1>
              {view.subtitle ? (
                <p className="text-muted-foreground text-[1em]">{view.subtitle}</p>
              ) : null}
            </div>
            {/* Hidden on paper: a download button printed onto a report that
                has already been handed over is noise. */}
            <Button asChild className="print:hidden" variant="outline">
              <a href={`/report/${encodeURIComponent(token)}/pdf`}>
                <DownloadIcon />
                Download PDF
              </a>
            </Button>
          </div>

          {/* Four facts, matching the office's letterhead: what form was
              used, who carried it out, and when. The inspector is omitted
              rather than shown blank when nobody is assigned — a report should
              not claim an inspector it does not have. */}
          <dl className="grid gap-4 border-t pt-4 sm:grid-cols-2">
            <div className="space-y-0.5">
              <dt className="text-muted-foreground text-[0.8em] font-medium">Inspection template</dt>
              <dd className="text-[1em] font-medium">{view.templateLabel}</dd>
            </div>
            {view.inspectorLabel ? (
              <div className="space-y-0.5">
                <dt className="text-muted-foreground text-[0.8em] font-medium">Inspector</dt>
                <dd className="text-[1em] font-medium">{view.inspectorLabel}</dd>
              </div>
            ) : null}
            <div className="space-y-0.5">
              <dt className="text-muted-foreground text-[0.8em] font-medium">Date</dt>
              <dd className="text-[1em] font-medium">{view.dateLabel}</dd>
            </div>
            {/* The one count the report keeps. The findings counters and the
                summary of findings that followed this header are gone with
                the findings lists they counted (2026-10-07). */}
            <div className="space-y-0.5">
              <dt className="text-muted-foreground text-[0.8em] font-medium">Rooms inspected</dt>
              <dd className="text-[1em] font-medium tabular-nums">
                {view.summary.roomsInspected} of {view.summary.roomsTotal}
              </dd>
            </div>
          </dl>
        </header>

        <section className="space-y-3">
          <h2 className="text-[1.3em] font-semibold tracking-tight">Room by room</h2>
          <div className="grid gap-4">
            {roomsWithEvidence.map((room) => (
              <Room key={room.id} room={room} />
            ))}
          </div>
        </section>

        {quietRooms.length ? (
          <section className="space-y-3">
            <h2 className="text-[1.3em] font-semibold tracking-tight">Other areas</h2>
            <p className="text-muted-foreground text-[1em]">
              Inspected with nothing to report, or not accessible on the day.
            </p>
            <ul className="bg-card divide-y rounded-xl border">
              {quietRooms.map((room) => (
                <li className="flex items-center justify-between gap-3 p-4" key={room.id}>
                  <span className="min-w-0 text-[1em]">
                    <span className="font-medium tracking-wide uppercase">{room.name}</span>
                    {room.floorName ? ` · ${room.floorName}` : ''}
                    {room.skipReason ? ` — ${room.skipReason}` : ''}
                  </span>
                  <Badge appearance="pill" variant="secondary">{room.statusLabel}</Badge>
                </li>
              ))}
            </ul>
          </section>
        ) : null}

        {/* The closing block, last and before the disclaimer, exactly where the
            office's own report puts it. Rendered only when something was
            written — three headings over three blanks says less than nothing. */}
        {view.closingNotes.length ? (
          <section className="grid gap-4 border-t pt-6 sm:grid-cols-3 print:break-inside-avoid">
            {view.closingNotes.map((note) => (
              <div key={note.label}>
                <h3 className="text-muted-foreground text-[0.8em] font-medium">{note.label}</h3>
                <p className="mt-1 text-[1em] whitespace-pre-line">{note.body}</p>
              </div>
            ))}
          </section>
        ) : null}

        <footer className="text-muted-foreground space-y-2 border-t pt-6 text-[0.8em]">
          <p className="text-pretty">{view.disclaimer}</p>
          <p>
            {[
              view.brand.name,
              view.brand.addressLine1,
              view.brand.addressLine2,
              view.brand.phone,
              view.brand.email,
            ]
              .filter(Boolean)
              .join(' · ')}
          </p>
          <p>Generated {view.generatedLabel}</p>
        </footer>
      </article>
    </ReportShell>
  );
}
