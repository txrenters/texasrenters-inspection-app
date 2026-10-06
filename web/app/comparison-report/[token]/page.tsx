'use client';

import { buildComparisonView } from '@texasrenters/shared';
import type { ComparisonReport } from '@texasrenters/shared';
import { DownloadIcon } from 'lucide-react';
import { useParams } from 'next/navigation';
import { useEffect, useMemo, useState } from 'react';

import { ComparisonDocument } from '@/components/comparison-document';
import { Button } from '@/components/ui/button';
import { Skeleton } from '@/components/ui/skeleton';
import { ApiError, publicApi } from '@/lib/api';

/**
 * The move-in / move-out comparison an owner or tenant opens from a share link
 * (the office, 2026-10-06), as the inspection report's link opens that report.
 *
 * The token is the only credential. The page carries only what a reviewer
 * approved, and only while the comparison is approved: changing it in review
 * pauses the link, which then says the report is being updated.
 */

/** Grid thumbnails and the full view; the backend caches both widths. */
const THUMB_WIDTH = 320;
const FULL_WIDTH = 1000;

function photoUrl(contentPath: string, width: number) {
  const base = process.env.NEXT_PUBLIC_API_BASE_URL?.replace(/\/$/, '') ?? '';
  return `${base}${contentPath}?w=${width}`;
}

function Shell({ children }: { children: React.ReactNode }) {
  return (
    <main className="bg-muted/40 min-h-dvh py-6 sm:py-10">
      <div className="mx-auto w-full max-w-5xl px-4">{children}</div>
    </main>
  );
}

export default function PublicComparisonReportPage() {
  const token = useParams<{ token: string }>().token;
  const [report, setReport] = useState<ComparisonReport | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!token) return;
    const controller = new AbortController();
    publicApi<ComparisonReport>(
      `/api/v1/reports/comparison/${encodeURIComponent(token)}`,
      controller.signal,
    )
      .then(setReport)
      .catch((cause) => {
        if (controller.signal.aborted) return;
        setError(
          cause instanceof ApiError && cause.code === 'COMPARISON_REPORT_UPDATING'
            ? cause.message
            : cause instanceof ApiError && cause.status === 404
              ? 'This report link is invalid, expired, or has been revoked. Contact your property manager for a new link.'
              : 'The report could not be loaded right now. Please try again later.',
        );
      });
    return () => controller.abort();
  }, [token]);

  const view = useMemo(() => (report ? buildComparisonView(report) : null), [report]);

  if (error)
    return (
      <Shell>
        <div className="bg-card space-y-2 rounded-xl border p-8 text-center" role="alert">
          <h1 className="text-xl font-semibold tracking-tight">Report unavailable</h1>
          <p className="text-muted-foreground text-sm text-pretty">{error}</p>
        </div>
      </Shell>
    );

  if (!view)
    return (
      <Shell>
        <div aria-busy="true" aria-live="polite" className="bg-card space-y-6 rounded-xl border p-8">
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
          <span className="sr-only">Loading your comparison report.</span>
        </div>
      </Shell>
    );

  return (
    <Shell>
      <ComparisonDocument
        actions={
          // Hidden on paper: a download button printed on a report already
          // handed over is noise.
          <Button asChild className="print:hidden" variant="outline">
            <a href={`/comparison-report/${encodeURIComponent(token)}/pdf`}>
              <DownloadIcon />
              Download PDF
            </a>
          </Button>
        }
        renderPhoto={(photo, context) => (
          <figure className="space-y-1">
            <a
              className="focus-visible:ring-ring/50 relative block overflow-hidden rounded-lg border focus-visible:ring-[3px] focus-visible:outline-none"
              href={photoUrl(photo.contentPath, FULL_WIDTH)}
              rel="noreferrer"
              target="_blank"
            >
              {/* Plain <img>: token-scoped API URLs, not optimizable assets. */}
              {/* eslint-disable-next-line @next/next/no-img-element */}
              <img
                alt={photo.caption ?? `${context.roomName} at ${context.side}`}
                className="aspect-[4/3] w-full object-cover transition-transform hover:scale-105"
                loading="lazy"
                src={photoUrl(photo.contentPath, THUMB_WIDTH)}
              />
              {photo.stamp ? (
                <span className="pointer-events-none absolute bottom-1.5 left-1.5 rounded bg-black/65 px-1.5 py-0.5 text-[10px] font-medium text-white tabular-nums">
                  {photo.stamp}
                </span>
              ) : null}
            </a>
            {photo.caption ? (
              <figcaption className="text-xs font-medium">{photo.caption}</figcaption>
            ) : null}
          </figure>
        )}
        view={view}
      />
    </Shell>
  );
}
