'use client';

import { useParams } from 'next/navigation';
import { useEffect, useMemo, useState } from 'react';

import { ApiError, publicApi } from '@/lib/api';
import { buildReportView } from '@texasrenters/shared';
import type { PublicInspectionReport, ReportFindingView, ReportRoomView } from '@texasrenters/shared';
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '@/components/ui/table';

/**
 * Homeowner-facing report. Presentation only: what appears, in what order, and
 * how it is worded comes from the shared `buildReportView`, which the PDF
 * renderer also consumes — see shared/src/report/report-view.ts.
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
      className="report-chip"
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
    <li className="report-finding" style={{ borderLeftColor: finding.tone.accent }}>
      <div className="report-finding-head">
        <strong>{finding.title}</strong>
        <SeverityChip finding={finding} />
      </div>
      <p className="report-meta">
        {showRoom ? `${finding.roomName} · ` : ''}
        {finding.categoryLabel} · {finding.comparisonLabel}
      </p>
      <p>{finding.description}</p>
      {finding.baselineCondition ? (
        <p className="report-baseline">At move-in: {finding.baselineCondition}</p>
      ) : null}
    </li>
  );
}

function Room({ room }: { room: ReportRoomView }) {
  return (
    <section className="report-room">
      <header className="report-room-head">
        <div>
          <h3>{room.name}</h3>
          {room.floorName ? <p className="report-meta">{room.floorName}</p> : null}
        </div>
        <span className={`report-chip ${room.inspected ? 'is-inspected' : 'is-quiet'}`}>
          {room.statusLabel}
        </span>
      </header>

      {/* The condition table, first in the room and before the photographs —
          the same order the office's printed reports use, because the table is
          the record and the photographs are its evidence.

          An empty cell means the technician did not assess that axis. It is
          deliberately blank rather than "N": the two are different claims, and
          printing "N" would publish a defect nobody observed. */}
      {room.checklist.length ? (
        <Table className="report-checklist">
          <TableHeader>
            <TableRow>
              <TableHead scope="col">Room / item</TableHead>
              <TableHead scope="col">Clean</TableHead>
              <TableHead scope="col">Undamaged</TableHead>
              <TableHead scope="col">Working</TableHead>
              <TableHead scope="col">Comments</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {room.checklist.map((row) => (
              <TableRow key={row.id}>
                <TableHead scope="row">{row.label}</TableHead>
                {/* Spoken as "Not assessed" so a blank cell is not silence to
                    a screen reader — the distinction from "No" matters as much
                    aloud as it does in print. */}
                <TableCell aria-label={row.clean || 'Not assessed'}>{row.clean}</TableCell>
                <TableCell aria-label={row.undamaged || 'Not assessed'}>{row.undamaged}</TableCell>
                <TableCell aria-label={row.working || 'Not assessed'}>{row.working}</TableCell>
                <TableCell className="report-checklist-comment">{row.comment}</TableCell>
              </TableRow>
            ))}
          </TableBody>
        </Table>
      ) : null}

      {room.photos.length ? (
        <div className="report-photo-grid">
          {room.photos.map((photo) => (
            <figure key={photo.id} className="report-photo">
              <a href={photoUrl(photo.contentPath, FULL_WIDTH)} target="_blank" rel="noreferrer">
                {/* Plain <img>: these are token-scoped API URLs, not optimizable assets. */}
                {/* eslint-disable-next-line @next/next/no-img-element */}
                <img
                  src={photoUrl(photo.contentPath, THUMB_WIDTH)}
                  alt={photo.caption ?? `Photo of ${room.name}`}
                  loading="lazy"
                />
              </a>
              <figcaption>
                {photo.caption ? <strong>{photo.caption}</strong> : null}
                {photo.stamp ? <span className="report-meta">{photo.stamp}</span> : null}
              </figcaption>
            </figure>
          ))}
        </div>
      ) : null}

      {room.findings.length ? (
        <ul className="report-finding-list">
          {room.findings.map((finding) => (
            <Finding key={finding.id} finding={finding} />
          ))}
        </ul>
      ) : null}

      {!room.hasEvidence ? (
        <p className="report-meta">
          {room.skipReason
            ? `Not inspected — ${room.skipReason}`
            : 'No issues were recorded for this room.'}
        </p>
      ) : null}
    </section>
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
      <main className="public-report">
        <div className="public-report-card">
          <h1>Report unavailable</h1>
          <p>{error}</p>
        </div>
      </main>
    );
  if (!view)
    return (
      <main className="public-report">
        <div className="public-report-card">
          <h1>Loading report…</h1>
          <p>Fetching your inspection report.</p>
        </div>
      </main>
    );

  const roomsWithEvidence = view.rooms.filter((room) => room.hasEvidence);
  const quietRooms = view.rooms.filter((room) => !room.hasEvidence);

  return (
    <main className="public-report">
      <div className="public-report-card">
        <header className="report-cover">
          <p className="report-kicker">{view.brand.name.toUpperCase()}</p>
          <h1>{view.title}</h1>
          {view.subtitle ? <p className="report-cover-sub">{view.subtitle}</p> : null}
          <div className="report-cover-meta">
            <div>
              <span>INSPECTION</span>
              <strong>{view.inspectionLabel}</strong>
            </div>
            <div>
              <span>DATE</span>
              <strong>{view.dateLabel}</strong>
            </div>
          </div>
          <a className="report-download" href={`/report/${encodeURIComponent(token)}/pdf`}>
            Download PDF
          </a>
        </header>

        <section>
          <h2>At a glance</h2>
          <div className="report-stats">
            <div className="report-stat">
              <strong>
                {view.summary.roomsInspected}/{view.summary.roomsTotal}
              </strong>
              <span>Rooms inspected</span>
            </div>
            <div className="report-stat">
              <strong>{view.summary.findingsTotal}</strong>
              <span>Findings reviewed</span>
            </div>
            {view.summary.severityCounts.map((entry) => (
              <div key={entry.severity} className="report-stat">
                <strong style={{ color: entry.tone.accent }}>{entry.count}</strong>
                <span>{entry.label}</span>
              </div>
            ))}
          </div>
        </section>

        <section>
          <h2>Summary of findings</h2>
          {view.summary.findingsTotal ? (
            <>
              <p className="report-meta">{view.summary.headline}, most significant first.</p>
              <ul className="report-finding-list">
                {view.allFindings.map((finding) => (
                  <Finding key={finding.id} finding={finding} showRoom />
                ))}
              </ul>
            </>
          ) : (
            <p>No findings were confirmed during review of this inspection.</p>
          )}
        </section>

        <section>
          <h2>Room by room</h2>
          <div className="report-rooms">
            {roomsWithEvidence.map((room) => (
              <Room key={room.id} room={room} />
            ))}
          </div>
        </section>

        {quietRooms.length ? (
          <section>
            <h2>Other areas</h2>
            <p className="report-meta">
              Inspected with nothing to report, or not accessible on the day.
            </p>
            <ul className="public-room-list">
              {quietRooms.map((room) => (
                <li key={room.id}>
                  <span>
                    {room.name}
                    {room.floorName ? ` · ${room.floorName}` : ''}
                    {room.skipReason ? ` — ${room.skipReason}` : ''}
                  </span>
                  <strong>{room.statusLabel}</strong>
                </li>
              ))}
            </ul>
          </section>
        ) : null}

        {view.otherFindings.length ? (
          <section>
            <h2>Additional findings</h2>
            <p className="report-meta">
              Recorded against areas that have since been renamed or merged.
            </p>
            <ul className="report-finding-list">
              {view.otherFindings.map((finding) => (
                <Finding key={finding.id} finding={finding} showRoom />
              ))}
            </ul>
          </section>
        ) : null}

        <footer className="public-report-footer">
          <p className="report-disclaimer">{view.disclaimer}</p>
          <p className="report-meta">
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
          <p className="report-meta">Generated {view.generatedLabel}</p>
        </footer>
      </div>
    </main>
  );
}
