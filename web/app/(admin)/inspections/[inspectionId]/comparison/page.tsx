'use client';

import { useParams } from 'next/navigation';

import { InspectionComparisonPanel } from '@/components/inspection-comparison';
import { InspectionTabs } from '@/components/inspection-tabs';
import { PageHeader } from '@/components/page-header';
import { EmptyState, ErrorState, PageSkeleton } from '@/components/states';
import { useInspection } from '@/lib/queries';

/**
 * Move-in vs move-out comparison, on its own page.
 *
 * The panel itself already existed and was fully built — classifications per
 * area, reviewer approval, per-area override. It was rendered inline near the
 * bottom of the inspection detail page, below the evidence workspace, the
 * charges panel and the assignment history, and only for MOVE_OUT. Nothing
 * linked to it, so in practice it was invisible: the comparison is a distinct
 * piece of work a reviewer sits down to do, not a footnote on another page.
 */
export default function InspectionComparisonPage() {
  const id = useParams<{ inspectionId: string }>().inspectionId;
  const inspection = useInspection(id);

  if (inspection.isError)
    return <ErrorState error={inspection.error} retry={() => void inspection.refetch()} />;
  // `!data` rather than `isLoading`, matching the detail page: isLoading is only
  // true on the first fetch, so it is false whenever the cache is emptied under
  // a mounted page.
  if (!inspection.data) return <PageSkeleton cards={2} />;

  const item = inspection.data;

  return (
    <>
      <PageHeader
        description={`${item.propertywareBuilding?.name ?? 'Inspection'} · ${
          item.propertywareUnit?.name ?? 'Entire property'
        }`}
        title="Move-in vs move-out"
      />

      <InspectionTabs active="comparison" inspectionId={id} inspectionType={item.inspectionType} />

      {/* A move-in *is* the baseline, so there is nothing to compare it
          against. Saying so beats rendering an empty comparison that looks
          like a generation failure. */}
      {item.inspectionType === 'MOVE_OUT' ? (
        <InspectionComparisonPanel inspectionId={id} />
      ) : (
        <EmptyState
          description="A comparison is drafted for a move-out inspection, against the move-in that established the baseline. This inspection is not a move-out."
          title="No comparison for this inspection type"
        />
      )}
    </>
  );
}
