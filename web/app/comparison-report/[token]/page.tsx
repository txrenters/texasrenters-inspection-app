'use client';

import type { ComparisonReport } from '@texasrenters/shared';
import { DownloadIcon } from 'lucide-react';
import { useParams } from 'next/navigation';
import { useEffect, useState } from 'react';

import { ComparisonReportView } from '@/components/comparison-report-view';
import { Button } from '@/components/ui/button';
import { Skeleton } from '@/components/ui/skeleton';
import { ApiError, publicApi } from '@/lib/api';

/** Grid thumbnails; the backend caches this width (see ALLOWED_PHOTO_WIDTHS). */
const THUMB_WIDTH = 320;
const FULL_WIDTH = 1000;

function photoUrl(contentPath: string, width: number) {
  const base = process.env.NEXT_PUBLIC_API_BASE_URL?.replace(/\/$/, '') ?? '';
  return `${base}${contentPath}?w=${width}`;
}

/**
 * The comparison report behind a share link.
 *
 * The token in the URL is the only credential, exactly as for the inspection
 * report — there is no session here, so photographs are plain `<img>` elements
 * pointed at the API. That works only because the photo route sets
 * `Cross-Origin-Resource-Policy: cross-origin`; Helmet's default blocks an image
 * the browser has already downloaded, and the failure looks like a broken photo
 * rather than a header problem.
 */
export default function PublicComparisonReportPage() {
  const params = useParams<{ token: string }>();
  const token = params?.token ?? '';
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
      .catch((cause: unknown) => {
        if (controller.signal.aborted) return;
        setError(
          cause instanceof ApiError
            ? cause.message
            : 'This report link is invalid, expired, or has been revoked.',
        );
      });
    return () => controller.abort();
  }, [token]);

  if (error)
    return (
      <main className="mx-auto max-w-2xl p-8">
        <h1 className="text-lg font-semibold">Report unavailable</h1>
        <p className="mt-2 text-sm text-muted-foreground">{error}</p>
      </main>
    );

  if (!report)
    return (
      <main className="mx-auto max-w-5xl space-y-4 p-6">
        <Skeleton className="h-32 w-full" />
        <Skeleton className="h-64 w-full" />
      </main>
    );

  return (
    <main className="mx-auto max-w-5xl space-y-4 p-6">
      <div className="flex justify-end print:hidden">
        <Button asChild size="sm" variant="outline">
          <a href={`/comparison-report/${encodeURIComponent(token)}/pdf`}>
            <DownloadIcon className="size-4" />
            Download PDF
          </a>
        </Button>
      </div>
      <ComparisonReportView
        renderPhoto={(photo, areaName) => (
          <a
            className="block overflow-hidden rounded-md border"
            href={photoUrl(photo.contentPath, FULL_WIDTH)}
            key={photo.id}
            rel="noreferrer"
            target="_blank"
          >
            {/* Plain <img>: these are token-scoped API URLs, not optimizable assets. */}
            {/* eslint-disable-next-line @next/next/no-img-element */}
            <img
              alt={`${photo.label ?? 'Photograph'} of ${areaName}`}
              className="h-24 w-full object-cover"
              loading="lazy"
              src={photoUrl(photo.contentPath, THUMB_WIDTH)}
            />
          </a>
        )}
        report={report}
      />
    </main>
  );
}
