'use client';

import { buildComparisonView } from '@texasrenters/shared';
import { ArrowLeftIcon, PrinterIcon, Share2Icon } from 'lucide-react';
import Link from 'next/link';
import { useParams } from 'next/navigation';
import { useMemo, useState } from 'react';

import { EvidenceViewer } from '@/components/area-evidence/EvidenceViewer';
import { LazyPhoto } from '@/components/area-evidence/LazyPhoto';
import { ComparisonDocument } from '@/components/comparison-document';
import type { ComparisonPhotoContext } from '@/components/comparison-document';
import { ReportShareDialog } from '@/components/report-share-dialog';
import { ErrorState, PageSkeleton } from '@/components/states';
import { Alert, AlertDescription, AlertTitle } from '@/components/ui/alert';
import { Button } from '@/components/ui/button';
import { usePermissions } from '@/lib/auth';
import { comparisonWaitingOn } from '@/lib/comparison-waiting';
import { useComparisonReport, useInspectionComparison } from '@/lib/queries';

/**
 * The comparison report as the owner or tenant will see it, before and after a
 * link is sent: the same document the share link and its PDF render, so what
 * the office checks here is what goes out (the office, 2026-10-06).
 *
 * Nothing stands between it and a link (the office, 2026-10-07): it used to
 * wait for every room to be decided and the whole approved. What has not
 * reached it yet -- recordings still processing, findings not yet confirmed --
 * is said above it, and it follows them by itself.
 */
export default function ComparisonReportPage() {
  const params = useParams<{ inspectionId: string }>();
  const inspectionId = params?.inspectionId ?? '';
  const permissions = usePermissions();
  const report = useComparisonReport(inspectionId);
  const comparison = useInspectionComparison(inspectionId);
  const [viewing, setViewing] = useState<ComparisonPhotoContext | null>(null);
  const [sharing, setSharing] = useState(false);
  const view = useMemo(() => (report.data ? buildComparisonView(report.data) : null), [report.data]);

  if (report.isLoading) return <PageSkeleton />;
  if (report.error || !view)
    return (
      <ErrorState
        error={report.error ?? new Error('Report unavailable')}
        retry={() => void report.refetch()}
      />
    );

  const waiting = comparison.data ? comparisonWaitingOn(comparison.data) : [];
  const canShare = permissions.has('reports:share');

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-center justify-between gap-2 print:hidden">
        <Button asChild size="sm" variant="ghost">
          <Link href={`/inspections/${inspectionId}/comparison`}>
            <ArrowLeftIcon className="size-4" />
            Back to comparison
          </Link>
        </Button>
        <div className="flex flex-wrap gap-2">
          <Button onClick={() => window.print()} size="sm" variant="outline">
            <PrinterIcon className="size-4" />
            Print
          </Button>
          {canShare ? (
            <Button disabled={!comparison.data} onClick={() => setSharing(true)} size="sm">
              <Share2Icon className="size-4" />
              Share with owner or tenant
            </Button>
          ) : null}
        </div>
      </div>

      <ComparisonDocument
        banner={
          waiting.length ? (
            <Alert className="print:hidden" variant="info">
              <AlertTitle>Still to come</AlertTitle>
              <AlertDescription>
                <ul className="list-disc space-y-0.5 pl-4">
                  {waiting.map((note) => (
                    <li key={note}>{note}</li>
                  ))}
                </ul>
                <p className="mt-1">
                  You can share it now: a link always shows the report as it stands.
                </p>
              </AlertDescription>
            </Alert>
          ) : null
        }
        renderPhoto={(photo, context) => (
          <LazyPhoto
            areaName={`${context.roomName} at ${context.side}`}
            onOpen={() => setViewing(context)}
            photo={{
              contentPath: photo.contentPath,
              label: photo.caption,
              capturedAt: photo.capturedAt,
              captureTimeSource: photo.captureTimeSource,
            }}
          />
        )}
        view={view}
      />

      {/* The inspection page's viewer, zoom and all. */}
      {viewing ? (
        <EvidenceViewer
          heading={`${viewing.roomName} · ${viewing.side}`}
          items={viewing.photos.map((photo) => ({
            id: photo.id,
            kind: 'photo',
            contentPath: photo.contentPath,
            title: photo.caption ?? 'Photograph',
            capturedAt: photo.capturedAt ?? undefined,
            captureTimeSource: photo.captureTimeSource,
          }))}
          onClose={() => setViewing(null)}
          startIndex={viewing.index}
        />
      ) : null}

      {sharing ? (
        <ReportShareDialog inspectionId={inspectionId} kind="COMPARISON" onClose={() => setSharing(false)} />
      ) : null}
    </div>
  );
}
