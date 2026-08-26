'use client';

import dynamic from 'next/dynamic';

import { PageHeader } from '@/components/page-header';
import { EmptyState } from '@/components/states';
import { Skeleton } from '@/components/ui/skeleton';
import { usePermissions } from '@/lib/auth';
import { formatRelative } from '@/lib/format';
import { usePropertyLocations, useTechnicianLocations } from '@/lib/queries';

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

/** The technician badge, small enough to sit in a line of text. */
function TechnicianSwatch({ stale = false }: { stale?: boolean }) {
  return (
    <svg aria-hidden="true" height="14" viewBox="0 0 28 28" width="14">
      <circle
        className={stale ? 'fill-map-technician-stale' : 'fill-map-technician'}
        cx="14"
        cy="14"
        r="11"
        stroke="#fff"
        strokeWidth="2.5"
      />
      <circle cx="14" cy="11.1" fill="#fff" r="2.9" />
      <path d="M8.1 20.4c0-3.2 2.7-5.2 5.9-5.2s5.9 2 5.9 5.2z" fill="#fff" />
    </svg>
  );
}

/** The property pin, at the same scale. */
function PropertySwatch() {
  return (
    <svg aria-hidden="true" height="15" viewBox="0 0 24 32" width="11">
      <path
        className="fill-map-property"
        d="M12 1.5c-5.5 0-10 4.4-10 9.9 0 7.4 10 19.1 10 19.1s10-11.7 10-19.1c0-5.5-4.5-9.9-10-9.9z"
        stroke="#fff"
        strokeWidth="2"
      />
      <path d="M12 6.6 6.6 11v6.1h3.6v-3.5h3.6v3.5h3.6V11z" fill="#fff" />
    </svg>
  );
}

function LegendKey({ children, swatch }: { children: React.ReactNode; swatch: React.ReactNode }) {
  return (
    <span className="text-muted-foreground flex items-center gap-1.5">
      {swatch}
      {children}
    </span>
  );
}

export default function TechnicianMapPage() {
  // `technicians:read` rather than `inspections:read`: where a named person was
  // at a given minute is a fact about them, not about an inspection, and the
  // two should not open with the same key.
  const permissions = usePermissions();
  const canView = permissions.has('technicians:read');
  const positions = useTechnicianLocations(canView);

  // Properties are a separate grant, and someone may hold one without the
  // other. Asked for only when it is held, so the console never fires a request
  // it knows will be refused.
  const properties = usePropertyLocations(canView && permissions.has('properties:read'));

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
        <div className="space-y-2">
          {/* `isolate` is load-bearing, not decoration. Leaflet gives its own
              controls `z-index: 1000` and its panes 400-700, and without a
              stacking context here those values compete with the whole page —
              so the theme menu and every other popover rendered into a portal
              at `z-50` came out *underneath* the map. Isolating confines
              Leaflet's z-indexes to this box, where they still order its own
              layers correctly and stop escaping. */}
          <div className="relative isolate h-[70vh] w-full overflow-hidden rounded-lg border">
            <TechnicianMap positions={positions.data ?? []} properties={properties.data ?? []} />

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

          {/* The swatches repeat the markers' own shapes rather than reducing
              them all to dots. A legend whose keys look nothing like the thing
              they explain makes the reader do the translation twice. */}
          <div className="flex flex-wrap items-center gap-x-4 gap-y-1 text-xs">
            <LegendKey swatch={<TechnicianSwatch />}>Technician, reported recently</LegendKey>
            <LegendKey swatch={<TechnicianSwatch stale />}>
              Technician, over 30 minutes ago
            </LegendKey>
            <LegendKey swatch={<PropertySwatch />}>
              Property {properties.data?.length ? `(${properties.data.length})` : null}
            </LegendKey>
          </div>
        </div>
      )}
    </>
  );
}
