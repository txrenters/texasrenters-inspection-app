'use client';

import dynamic from 'next/dynamic';

import { PageHeader } from '@/components/page-header';
import { EmptyState, ErrorState } from '@/components/states';
import { Skeleton } from '@/components/ui/skeleton';
import { usePermissions } from '@/lib/auth';
import { formatRelative } from '@/lib/format';
import { useTechnicianLocations } from '@/lib/queries';

/**
 * `ssr: false` is not optional. Leaflet reads `window` at import time and
 * measures its container to lay tiles out, so a server render throws before it
 * can produce anything — and `dynamic` may only disable SSR from a client
 * component, which is why this page is one.
 */
const TechnicianMap = dynamic(
  () => import('@/components/technician-map').then((module) => module.TechnicianMap),
  {
    ssr: false,
    loading: () => <Skeleton className="h-full w-full rounded-lg" />,
  },
);

export default function TechnicianMapPage() {
  // `technicians:read` rather than `inspections:read`: where a named person was
  // at a given minute is a fact about them, not about an inspection, and the
  // two should not open with the same key.
  const canView = usePermissions().has('technicians:read');
  const positions = useTechnicianLocations(canView);

  const newest = positions.data?.reduce<string | null>(
    (latest, position) => (!latest || position.recordedAt > latest ? position.recordedAt : latest),
    null,
  );

  return (
    <>
      <PageHeader
        description={
          newest
            ? `Last known position of each technician. Most recent report ${formatRelative(newest)}.`
            : 'Last known position of each technician, reported while they are on shift.'
        }
        title="Technician map"
      />

      {!canView ? (
        <EmptyState
          description="Ask an administrator for the technicians permission if you need it."
          title="You do not have access to technician locations"
        />
      ) : positions.isError ? (
        <ErrorState error={positions.error} retry={() => void positions.refetch()} />
      ) : positions.isLoading ? (
        <Skeleton className="h-[70vh] w-full rounded-lg" />
      ) : !positions.data?.length ? (
        // Distinguished from an error on purpose. Nothing here usually means
        // nobody is on shift, which is a normal state at seven in the evening
        // and not a fault anybody should go looking for.
        <EmptyState
          description="Positions appear here once a technician turns their shift on in the app."
          title="No technician has reported a position yet"
        />
      ) : (
        <div className="h-[70vh] w-full overflow-hidden rounded-lg border">
          <TechnicianMap positions={positions.data} />
        </div>
      )}
    </>
  );
}
