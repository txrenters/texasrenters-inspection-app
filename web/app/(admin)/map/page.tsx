'use client';

import dynamic from 'next/dynamic';

import { PageHeader } from '@/components/page-header';
import { EmptyState } from '@/components/states';
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
      ) : (
        /* The map is the page, and it renders whether or not anybody has
           reported. An empty map still says where the work is — the city, the
           streets, the shape of the patch — and replacing it with a card meant
           the most ordinary state of all, nobody on shift, showed nothing at
           all. Anything worth saying is said over the top of it instead. */
        <div className="relative h-[70vh] w-full overflow-hidden rounded-lg border">
          <TechnicianMap positions={positions.data ?? []} />

          {positions.isError || (!positions.isLoading && !positions.data?.length) ? (
            /* `pointer-events-none` on the wrapper and restored on the notice:
               a banner that swallowed drags would make the map behind it look
               broken. z-[1000] because Leaflet's own panes sit at 400-700. */
            <div className="pointer-events-none absolute inset-x-0 top-3 z-[1000] flex justify-center px-3">
              <div className="bg-background/95 pointer-events-auto rounded-md border px-3 py-2 text-sm shadow-sm">
                {positions.isError ? (
                  <span className="flex items-center gap-2">
                    <span className="text-destructive">Could not load positions.</span>
                    <button
                      className="underline underline-offset-4"
                      onClick={() => void positions.refetch()}
                      type="button"
                    >
                      Try again
                    </button>
                  </span>
                ) : (
                  <span className="text-muted-foreground">
                    No technician has reported a position yet — they appear once somebody turns
                    their shift on in the app.
                  </span>
                )}
              </div>
            </div>
          ) : null}
        </div>
      )}
    </>
  );
}
