'use client';

import { useParams } from 'next/navigation';

import { InspectionSummaries } from '@/components/area-evidence/InspectionSummaries';
import { InspectionTabs } from '@/components/inspection-tabs';
import { PageHeader } from '@/components/page-header';
import { ErrorState, PageSkeleton } from '@/components/states';
import { useInspection } from '@/lib/queries';

/**
 * "Summaries of all areas": every room's summary of its recordings on one page
 * (the maintenance team, 2026-10-07). The report prints only what each room
 * needs; this keeps the timestamped points, for the office.
 */
export default function InspectionSummariesPage() {
  const id = useParams<{ inspectionId: string }>().inspectionId;
  const inspection = useInspection(id);

  if (inspection.isError)
    return <ErrorState error={inspection.error} retry={() => void inspection.refetch()} />;
  if (!inspection.data) return <PageSkeleton cards={2} />;

  const item = inspection.data;

  return (
    <>
      <PageHeader
        description={`${item.propertywareBuilding?.name ?? 'Inspection'} · ${
          item.propertywareUnit?.name ?? 'Entire property'
        }`}
        title="Summaries of all areas"
      />

      <InspectionTabs active="summaries" inspectionId={id} inspectionType={item.inspectionType} />

      <InspectionSummaries inspectionId={id} />
    </>
  );
}
