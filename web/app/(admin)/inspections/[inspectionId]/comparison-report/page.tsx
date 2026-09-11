'use client';

import type { PublicReportPhoto } from '@texasrenters/shared';
import { ArrowLeftIcon, PrinterIcon } from 'lucide-react';
import Link from 'next/link';
import { useParams } from 'next/navigation';
import { useState } from 'react';

import { LazyPhoto } from '@/components/area-evidence/LazyPhoto';
import { ComparisonReportView } from '@/components/comparison-report-view';
import type { PhotoContext } from '@/components/comparison-report-view';
import { PhotoLightbox } from '@/components/photo-lightbox';
import { ErrorState, PageSkeleton } from '@/components/states';
import { Button } from '@/components/ui/button';
import { useComparisonReport } from '@/lib/queries';

/** Which photograph the viewer is open on, and the set it belongs to. */
type Viewing = PhotoContext | null;

export default function ComparisonReportPage() {
  const params = useParams<{ inspectionId: string }>();
  const inspectionId = params?.inspectionId ?? '';
  const { data, isLoading, error, refetch } = useComparisonReport(inspectionId);
  const [viewing, setViewing] = useState<Viewing>(null);

  if (isLoading) return <PageSkeleton />;
  if (error || !data)
    return (
      <ErrorState error={error ?? new Error('Report unavailable')} retry={() => void refetch()} />
    );

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-center justify-between gap-2 print:hidden">
        <Button asChild size="sm" variant="ghost">
          <Link href={`/inspections/${inspectionId}/comparison`}>
            <ArrowLeftIcon className="size-4" />
            Back to comparison
          </Link>
        </Button>
        <Button onClick={() => window.print()} size="sm" variant="outline">
          <PrinterIcon className="size-4" />
          Print
        </Button>
      </div>

      {/*
        Photographs are fetched with credentials and rendered as blobs, which is
        also why the console was never affected by the CORP header that broke
        shared-report images. Clicking one opens it large enough to read the
        damage off, and to save the original for a deck.
      */}
      <ComparisonReportView
        renderPhoto={(photo: PublicReportPhoto, context) => (
          <button
            className="block cursor-zoom-in text-left"
            key={photo.id}
            onClick={() => setViewing(context)}
            type="button"
          >
            <LazyPhoto areaName={context.areaName} photo={photo} />
          </button>
        )}
        report={data}
      />

      {viewing ? (
        <PhotoLightbox
          areaName={viewing.areaName}
          index={viewing.index}
          onClose={() => setViewing(null)}
          photos={viewing.photos}
          sideLabel={viewing.sideLabel}
        />
      ) : null}
    </div>
  );
}
