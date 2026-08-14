'use client';

import { buildReportView } from '@texasrenters/shared';
import type {
  PublicInspectionReport,
  ReportFindingView,
  ReportRoomView,
} from '@texasrenters/shared';
import { DownloadIcon } from 'lucide-react';
import Image from 'next/image';
import { useParams } from 'next/navigation';
import { useEffect, useMemo, useState } from 'react';

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

/**
 * Homeowner-facing report. Presentation only: what appears, in what order, and
 * how it is worded comes from the shared `buildReportView`, which the PDF
 * renderer also consumes — see shared/src/report/report-view.ts.
 *
 * The one place in this app where colour arrives as data rather than as a token.
 * Severity tones come from the shared view model precisely so the web page and
 * the PDF cannot disagree about what "Major" looks like, so they are applied
 * inline. Everything else here uses the theme.
 */

/** Grid thumbnails; the backend caches this width (see ALLOWED_PHOTO_WIDTHS). */
const THUMB_WIDTH = 320;
const FULL_WIDTH = 1000;

function photoUrl(contentPath: string, width: number) {
  const base = process.env.NEXT_PUBLIC_API_BASE_URL?.replace(/\/$/, '') ?? '';
  return `${base}${contentPath}?w=${width}`;
}

function SeverityChip({ finding }: { finding: ReportFindingView }) {
  return (
    <span
      className="inline-flex shrink-0 items-center rounded-md border px-2 py-0.5 text-xs font-medium"
      style={{
        color: finding.tone.accent,
        background: finding.tone.surface,
        borderColor: finding.tone.border,
      }}
    >
      {finding.severityLabel}
    </span>
  );
}

function Finding({ finding, showRoom }: { finding: ReportFindingView; showRoom?: boolean }) {
  return (
    <li
      className="bg-card space-y-1.5 rounded-r-lg border-l-4 py-3 pr-3 pl-4"
      style={{ borderLeftColor: finding.tone.accent }}
    >
      <div className="flex flex-wrap items-start justify-between gap-2">
        <p className="font-medium">{finding.title}</p>
        <SeverityChip finding={finding} />
      </div>
      <p className="text-muted-foreground text-xs">
        {showRoom ? `${finding.roomName} · ` : ''}
        {finding.categoryLabel} · {finding.comparisonLabel}
      </p>
      <p className="text-sm leading-relaxed">{finding.description}</p>
      {finding.baselineCondition ? (
        <p className="text-muted-foreground text-sm">At move-in: {finding.baselineCondition}</p>
      ) : null}
    </li>
  );
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
      className={
        value === 'Y'
          ? 'text-success font-semibold'
          : value === 'N'
            ? 'text-destructive font-semibold'
            : ''
      }
    >
      {value}
    </TableCell>
  );
}

function Room({ room }: { room: ReportRoomView }) {
  return (
    // `print:break-inside-avoid`: a page break between a room's verdicts and
    // the photographs proving them is what makes a printed report hard to read.
    <section className="bg-card space-y-4 rounded-xl border p-5 print:break-inside-avoid">
      <header className="flex flex-wrap items-start justify-between gap-2">
        <div>
          <h3 className="font-semibold">{room.name}</h3>
          {room.floorName ? (
            <p className="text-muted-foreground text-xs">{room.floorName}</p>
          ) : null}
        </div>
        <Badge variant={room.inspected ? 'success' : 'secondary'}>{room.statusLabel}</Badge>
      </header>

      {/* The condition table, first in the room and before the photographs — the
          same order the office's printed reports use, because the table is the
          record and the photographs are its evidence.

          An empty cell means the technician did not assess that axis. It is
          deliberately blank rather than "N": the two are different claims, and
          printing "N" would publish a defect nobody observed. */}
      {room.checklist.length ? (
        <div className="overflow-hidden rounded-lg border">
          <Table>
            <TableHeader className="bg-muted/40 print:table-header-group">
              <TableRow className="hover:bg-transparent">
                <TableHead scope="col">Room / item</TableHead>
                <TableHead scope="col">Clean</TableHead>
                <TableHead scope="col">Undamaged</TableHead>
                <TableHead scope="col">Working</TableHead>
                <TableHead scope="col">Comments</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {room.checklist.map((row) => (
                <TableRow className="print:break-inside-avoid" key={row.id}>
                  <TableHead className="text-foreground h-auto py-3 font-normal" scope="row">
                    {row.label}
                  </TableHead>
                  {/* Spoken as "Not assessed" so a blank cell is not silence to a
                      screen reader — the distinction from "No" matters as much
                      aloud as it does in print. */}
                  <AxisCell value={row.clean} />
                  <AxisCell value={row.undamaged} />
                  <AxisCell value={row.working} />
                  <TableCell className="text-muted-foreground">{row.comment}</TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        </div>
      ) : null}

      {room.photos.length ? (
        <div className="grid grid-cols-2 gap-3 sm:grid-cols-3 lg:grid-cols-4">
          {room.photos.map((photo) => (
            <figure className="space-y-1.5 print:break-inside-avoid" key={photo.id}>
              <a
                className="focus-visible:ring-ring/50 block overflow-hidden rounded-lg border focus-visible:ring-[3px] focus-visible:outline-none"
                href={photoUrl(photo.contentPath, FULL_WIDTH)}
                rel="noreferrer"
                target="_blank"
              >
                {/* Plain <img>: these are token-scoped API URLs, not optimizable assets. */}
                {/* eslint-disable-next-line @next/next/no-img-element */}
                <img
                  alt={photo.caption ?? `Photo of ${room.name}`}
                  className="aspect-[4/3] w-full object-cover transition-transform hover:scale-105"
                  loading="lazy"
                  src={photoUrl(photo.contentPath, THUMB_WIDTH)}
                />
              </a>
              <figcaption className="space-y-0.5">
                {photo.caption ? <p className="text-xs font-medium">{photo.caption}</p> : null}
                {photo.stamp ? (
                  <p className="text-muted-foreground text-xs">{photo.stamp}</p>
                ) : null}
              </figcaption>
            </figure>
          ))}
        </div>
      ) : null}

      {room.findings.length ? (
        <ul className="grid gap-2">
          {room.findings.map((finding) => (
            <Finding finding={finding} key={finding.id} />
          ))}
        </ul>
      ) : null}

      {!room.hasEvidence ? (
        <p className="text-muted-foreground text-sm">
          {room.skipReason
            ? `Not inspected — ${room.skipReason}`
            : 'No issues were recorded for this room.'}
        </p>
      ) : null}
    </section>
  );
}

function ReportShell({ children }: { children: React.ReactNode }) {
  return (
    <main className="bg-muted/40 min-h-dvh py-6 sm:py-10">
      <div className="mx-auto w-full max-w-4xl px-4">{children}</div>
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
          <h1 className="text-xl font-semibold tracking-tight">Report unavailable</h1>
          <p className="text-muted-foreground text-sm text-pretty">{error}</p>
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
              <h1 className="text-2xl font-semibold tracking-tight text-balance">{view.title}</h1>
              {view.subtitle ? (
                <p className="text-muted-foreground text-sm">{view.subtitle}</p>
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
              <dt className="text-muted-foreground text-xs font-medium">Inspection template</dt>
              <dd className="text-sm font-medium">{view.templateLabel}</dd>
            </div>
            {view.inspectorLabel ? (
              <div className="space-y-0.5">
                <dt className="text-muted-foreground text-xs font-medium">Inspector</dt>
                <dd className="text-sm font-medium">{view.inspectorLabel}</dd>
              </div>
            ) : null}
            <div className="space-y-0.5">
              <dt className="text-muted-foreground text-xs font-medium">Date</dt>
              <dd className="text-sm font-medium">{view.dateLabel}</dd>
            </div>
          </dl>
        </header>

        <section className="space-y-3">
          <h2 className="text-lg font-semibold tracking-tight">At a glance</h2>
          <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
            <div className="bg-card rounded-xl border p-4">
              <p className="text-2xl font-semibold tabular-nums">
                {view.summary.roomsInspected}/{view.summary.roomsTotal}
              </p>
              <p className="text-muted-foreground mt-0.5 text-xs">Rooms inspected</p>
            </div>
            <div className="bg-card rounded-xl border p-4">
              <p className="text-2xl font-semibold tabular-nums">{view.summary.findingsTotal}</p>
              <p className="text-muted-foreground mt-0.5 text-xs">Findings reviewed</p>
            </div>
            {view.summary.severityCounts.map((entry) => (
              <div className="bg-card rounded-xl border p-4" key={entry.severity}>
                <p
                  className="text-2xl font-semibold tabular-nums"
                  style={{ color: entry.tone.accent }}
                >
                  {entry.count}
                </p>
                <p className="text-muted-foreground mt-0.5 text-xs">{entry.label}</p>
              </div>
            ))}
          </div>
        </section>

        <section className="space-y-3">
          <h2 className="text-lg font-semibold tracking-tight">Summary of findings</h2>
          {view.summary.findingsTotal ? (
            <>
              <p className="text-muted-foreground text-sm">
                {view.summary.headline}, most significant first.
              </p>
              <ul className="grid gap-2">
                {view.allFindings.map((finding) => (
                  <Finding finding={finding} key={finding.id} showRoom />
                ))}
              </ul>
            </>
          ) : (
            <p className="bg-card rounded-xl border p-5 text-sm">
              No findings were confirmed during review of this inspection.
            </p>
          )}
        </section>

        <section className="space-y-3">
          <h2 className="text-lg font-semibold tracking-tight">Room by room</h2>
          <div className="grid gap-4">
            {roomsWithEvidence.map((room) => (
              <Room key={room.id} room={room} />
            ))}
          </div>
        </section>

        {quietRooms.length ? (
          <section className="space-y-3">
            <h2 className="text-lg font-semibold tracking-tight">Other areas</h2>
            <p className="text-muted-foreground text-sm">
              Inspected with nothing to report, or not accessible on the day.
            </p>
            <ul className="bg-card divide-y rounded-xl border">
              {quietRooms.map((room) => (
                <li className="flex items-center justify-between gap-3 p-4" key={room.id}>
                  <span className="min-w-0 text-sm">
                    {room.name}
                    {room.floorName ? ` · ${room.floorName}` : ''}
                    {room.skipReason ? ` — ${room.skipReason}` : ''}
                  </span>
                  <Badge variant="secondary">{room.statusLabel}</Badge>
                </li>
              ))}
            </ul>
          </section>
        ) : null}

        {view.otherFindings.length ? (
          <section className="space-y-3">
            <h2 className="text-lg font-semibold tracking-tight">Additional findings</h2>
            <p className="text-muted-foreground text-sm">
              Recorded against areas that have since been renamed or merged.
            </p>
            <ul className="grid gap-2">
              {view.otherFindings.map((finding) => (
                <Finding finding={finding} key={finding.id} showRoom />
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
                <h3 className="text-muted-foreground text-xs font-medium">{note.label}</h3>
                <p className="mt-1 text-sm whitespace-pre-line">{note.body}</p>
              </div>
            ))}
          </section>
        ) : null}

        <footer className="text-muted-foreground space-y-2 border-t pt-6 text-xs">
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
