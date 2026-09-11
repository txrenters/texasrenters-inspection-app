'use client';

import { ArrowLeftIcon, PrinterIcon } from 'lucide-react';
import Link from 'next/link';
import { useParams } from 'next/navigation';

import { LazyPhoto } from '@/components/area-evidence/LazyPhoto';
import { ComparisonReportView } from '@/components/comparison-report-view';
import { ErrorState, PageSkeleton } from '@/components/states';
import { Button } from '@/components/ui/button';
import { useComparisonReport } from '@/lib/queries';

export default function ComparisonReportPage() {
  const params = useParams<{ inspectionId: string }>();
  const inspectionId = params?.inspectionId ?? '';
  const { data, isLoading, error, refetch } = useComparisonReport(inspectionId);

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
        The console has a session, so photographs are fetched with credentials
        and rendered as blobs — which is also why the console was never affected
        by the CORP header that broke shared-report images.
      */}
      <ComparisonReportView
        renderPhoto={(photo, areaName) => (
          <LazyPhoto areaName={areaName} key={photo.id} photo={photo} />
        )}
        report={data}
      />
    </div>
  );
}
