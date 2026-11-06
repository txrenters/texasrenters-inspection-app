import { jobWorkLine, type AdminInspection } from '@texasrenters/shared';
import { TriangleAlertIcon } from 'lucide-react';
import { Fragment } from 'react';

/**
 * What a job is, under its address (the office, 2026-11-06: "on the title,
 * include all the necessary details, like the job type, occupied or not, TBP
 * or not"):
 *
 *   Katy, TX · TBP · Occupied · Q4 2026 · Zone 1 · Job #20636
 *   AC filter change + Pest control + Occupied inspection
 *
 * Plain words, not badges: the status beside the title is the page's one badge,
 * and a row of them reads as a row of statuses.
 */
export function jobFacts(item: AdminInspection): string[] {
  return [
    jobPlace(item),
    item.tbpVisit ? 'TBP' : 'Not TBP',
    item.occupancy === 'OCCUPIED' ? 'Occupied' : item.occupancy === 'VACANT' ? 'Vacant' : null,
    item.tbpVisit && item.quarter ? item.quarter : null,
    item.zone ? `Zone ${item.zone}` : null,
    item.jobberJobNumber ? `Job #${item.jobberJobNumber}` : null,
    item.propertywareUnit?.name ?? null,
  ].filter((fact): fact is string => Boolean(fact));
}

/**
 * Where it is, beyond what the title says. The title is the building's name,
 * usually its street, so this is the town; a name that isn't the street leaves
 * the whole address to say.
 */
function jobPlace(item: AdminInspection): string | null {
  const building = item.propertywareBuilding;
  if (!building) return null;
  const street = building.addressLine1?.trim().toLowerCase();
  const named = Boolean(street) && building.name.toLowerCase().includes(street ?? '');
  return [named ? null : building.addressLine1, building.city, building.state].filter(Boolean).join(', ') || null;
}

export function JobHeadline({ item }: { item: AdminInspection }) {
  const facts = jobFacts(item);
  const work = jobWorkLine(item);
  return (
    <div className="grid gap-0.5">
      <p className="flex flex-wrap items-center gap-x-1.5" data-testid="job-facts">
        {facts.map((fact, index) => (
          <Fragment key={fact}>
            {index ? <span aria-hidden>·</span> : null}
            {/* Today's, from Propertyware: a done job may have been lived in on the day. */}
            <span
              className={fact === 'TBP' ? 'text-foreground font-medium' : undefined}
              title={fact === 'Occupied' || fact === 'Vacant' ? 'Today, from Propertyware' : undefined}
            >
              {fact}
            </span>
          </Fragment>
        ))}
      </p>
      {work ? <p className="text-foreground font-medium">{work}</p> : null}
      {/* The visit decides it is TBP; the tenant may have left the package since it was booked. */}
      {item.tbpVisit && item.tbp === 'NOT_ENROLLED' ? (
        <p className="text-warning flex items-center gap-1.5 text-xs">
          <TriangleAlertIcon aria-hidden className="size-3.5 shrink-0" />
          The tenant is not enrolled in TBP today.
        </p>
      ) : null}
    </div>
  );
}
