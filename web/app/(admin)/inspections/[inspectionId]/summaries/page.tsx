'use client';

import { useParams } from 'next/navigation';

import { InspectionSummaries } from '@/components/area-evidence/InspectionSummaries';
import { InspectionTabs } from '@/components/inspection-tabs';
import { JobTabHeader } from '@/components/job-tab-header';
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
      {/* The job's own header on every tab: which property this is stays in
          the title, and the tab says which part of it is open (2026-11-17). */}
      <JobTabHeader item={item} />

      <InspectionTabs active="summaries" inspectionId={id} inspectionType={item.inspectionType} />

      <InspectionSummaries inspectionId={id} />
    </>
  );
}
