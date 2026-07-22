'use client';

import { useParams } from 'next/navigation';
import { useEffect, useState } from 'react';

import { ApiError, publicApi } from '@/lib/api';
import type { PublicInspectionReport } from '@texasrenters/shared';

function formatDay(value?: string | null) {
  if (!value) return '—';
  return new Intl.DateTimeFormat('en-US', {
    month: 'long',
    day: 'numeric',
    year: 'numeric',
  }).format(new Date(value));
}

function formatLabel(value: string) {
  return value
    .replaceAll('_', ' ')
    .toLowerCase()
    .replace(/(^|\s)\S/g, (character) => character.toUpperCase());
}

export default function PublicReportPage() {
  const token = useParams<{ token: string }>().token;
  const [report, setReport] = useState<PublicInspectionReport | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!token) return;
    const controller = new AbortController();
    publicApi<PublicInspectionReport>(`/api/v1/reports/${encodeURIComponent(token)}`, controller.signal)
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

  if (error)
    return (
      <main className="public-report">
        <div className="public-report-card">
          <h1>Report unavailable</h1>
          <p>{error}</p>
        </div>
      </main>
    );
  if (!report)
    return (
      <main className="public-report">
        <div className="public-report-card">
          <h1>Loading report…</h1>
          <p>Fetching your inspection report.</p>
        </div>
      </main>
    );

  const completedRooms = report.rooms.filter((room) => room.completionStatus === 'COMPLETED');
  return (
    <main className="public-report">
      <div className="public-report-card">
        <header className="public-report-header">
          <p className="public-report-brand">TEXASRENTERS · INSPECTION REPORT</p>
          <h1>
            {report.property.addressLine1 || report.property.name}
            {report.property.unitName ? `, Unit ${report.property.unitName}` : ''}
          </h1>
          <p>
            {[report.property.city, report.property.state, report.property.postalCode]
              .filter(Boolean)
              .join(', ')}
          </p>
          <p className="media-meta">
            {formatLabel(report.inspection.type)} inspection · {formatLabel(report.inspection.status)}
            {' · '}
            {report.inspection.completedAt
              ? `Completed ${formatDay(report.inspection.completedAt)}`
              : `Scheduled ${formatDay(report.inspection.scheduledAt)}`}
          </p>
        </header>

        <section>
          <h2>Rooms inspected</h2>
          <p className="media-meta">
            {completedRooms.length} of {report.rooms.length} rooms completed
          </p>
          <ul className="public-room-list">
            {report.rooms.map((room) => (
              <li key={room.id}>
                <span>
                  {room.name}
                  {room.floorName ? ` · ${room.floorName}` : ''}
                </span>
                <strong>{formatLabel(room.completionStatus)}</strong>
              </li>
            ))}
          </ul>
        </section>

        <section>
          <h2>Reviewed findings</h2>
          {report.findings.length ? (
            <ul className="public-finding-list">
              {report.findings.map((finding) => (
                <li key={finding.id}>
                  <div className="public-finding-head">
                    <strong>{finding.title}</strong>
                    <span className="public-finding-severity">{formatLabel(finding.severity)}</span>
                  </div>
                  <p className="media-meta">
                    {finding.roomName} · {formatLabel(finding.category)} ·{' '}
                    {formatLabel(finding.comparisonResult)}
                  </p>
                  <p>{finding.description}</p>
                  {finding.baselineCondition ? (
                    <p className="media-meta">Move-in baseline: {finding.baselineCondition}</p>
                  ) : null}
                </li>
              ))}
            </ul>
          ) : (
            <p>No findings were confirmed during review of this inspection.</p>
          )}
        </section>

        <footer className="public-report-footer">
          <p className="media-meta">
            Generated {formatDay(report.generatedAt)} · Every finding in this report was reviewed
            and approved by the TexasRenters team. This report is informational and does not by
            itself authorize charges or determine responsibility.
          </p>
        </footer>
      </div>
    </main>
  );
}
