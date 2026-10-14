'use client';

import type { QuarterDayGroup, QuarterPackageChanges, QuarterVisitPlace } from '@texasrenters/shared';
import { HistoryIcon, UserMinusIcon, UserPlusIcon } from 'lucide-react';
import Link from 'next/link';
import type { ReactNode } from 'react';

import { EmptyState } from '@/components/states';
import { formatDate } from '@/lib/format';
import { quarterName } from '@/lib/planning';
import { cn } from '@/lib/utils';

import { leftReasonText, newcomerSince } from './package-changes';
import { eventSource, eventText, placeText, quarterChangesSummary, stillVisitedThisQuarter } from './quarter-package-changes';

/**
 * The plan's "Package changes" tab (the office, 2026-10-15): "we should have
 * a way to know if a property has opted out or left the TBP ... where was
 * that, what group", and "if there's a new tbp ... we should know also".
 *
 * Last quarter's plan is what "was" means: who it visited that has left since,
 * with the day and group of that visit; who is in the package now that it did
 * not visit, with where this quarter put them. The Group maker is where a
 * newcomer is given a group.
 */
export function QuarterPackageChangesView({ changes }: { changes: QuarterPackageChanges }) {
  const since = changes.previous ? quarterName(changes.previous.quarterYear, changes.previous.quarterNumber) : null;
  const summary = quarterChangesSummary(changes, since);

  return (
    <div className="grid gap-4">
      <p className="text-muted-foreground text-sm" role="status">
        {summary ??
          (since
            ? `No property left or joined the benefit package since ${since}.`
            : 'No property this quarter has left the benefit package.')}
        {since ? null : ' There is no plan for last quarter to compare with, so nothing is called new.'}
      </p>

      {changes.left.length || changes.joined.length ? (
        <div className="grid gap-4 lg:grid-cols-2">
          {changes.left.length ? (
            <Section
              icon={<UserMinusIcon aria-hidden className="text-warning size-4" />}
              note={
                since
                  ? `Visited in ${since}, or planned this quarter, and out of the package now. A visit not yet published left this quarter’s plan by itself; one published did not, and is for a person to cancel or keep.`
                  : 'Planned this quarter and out of the package now. A visit not yet published left the plan by itself; one published did not.'
              }
              title={`Left the package (${changes.left.length.toLocaleString()})`}
            >
              {changes.left.map((leaver) => (
                <li className="grid gap-1 py-2" key={leaver.buildingId}>
                  <PropertyLink address={leaver.address} buildingId={leaver.buildingId} />
                  <span className="text-muted-foreground text-xs">
                    {leaver.reasons.length ? leaver.reasons.map(leftReasonText).join('; ') : 'No longer in the package'}
                  </span>
                  {leaver.lastQuarter ? <Place label={since ?? 'Last quarter'} place={leaver.lastQuarter} /> : null}
                  {leaver.thisQuarter ? (
                    <Place
                      emphasis={stillVisitedThisQuarter(leaver.thisQuarter)}
                      label="This quarter"
                      place={leaver.thisQuarter}
                      suffix={stillVisitedThisQuarter(leaver.thisQuarter) ? 'still booked: cancel it or keep it' : null}
                    />
                  ) : null}
                </li>
              ))}
            </Section>
          ) : null}

          {changes.joined.length ? (
            <Section
              icon={<UserPlusIcon aria-hidden className="text-success size-4" />}
              note={`In the package now and not visited in ${since}. One with no visit this quarter joined after the quarter was built: give it a group in the Group maker, then rebuild.`}
              title={`New since ${since} (${changes.joined.length.toLocaleString()})`}
            >
              {changes.joined.map((joiner) => (
                <li className="grid gap-1 py-2" key={joiner.buildingId}>
                  <div className="flex flex-wrap items-baseline gap-x-2">
                    <PropertyLink address={joiner.address} buildingId={joiner.buildingId} />
                    <span className="text-muted-foreground text-xs">{newcomerSince(joiner)}</span>
                  </div>
                  {joiner.thisQuarter ? (
                    <Place label="This quarter" place={joiner.thisQuarter} />
                  ) : (
                    <span className="text-warning text-xs">
                      Not in this quarter’s plan.{' '}
                      <Link className="underline underline-offset-2" href="/group-maker">
                        Find it a group
                      </Link>
                    </span>
                  )}
                </li>
              ))}
            </Section>
          ) : null}
        </div>
      ) : null}

      <section aria-label="Benefit package history" className="grid gap-1">
        <h3 className="flex items-center gap-2 text-sm font-medium">
          <HistoryIcon aria-hidden className="text-muted-foreground size-4" />
          History{since ? ` since ${since} began` : ''}
        </h3>
        <p className="text-muted-foreground text-xs">
          Every property the nightly tenant report or a switch on a property’s page moved into or out of the package. Kept
          since Oct 15, 2026.
        </p>
        {changes.history.length ? (
          <div className="overflow-x-auto rounded-lg border">
            <table className="w-full text-sm">
              <thead className="bg-muted/40 text-muted-foreground text-left text-xs">
                <tr>
                  <th className="px-3 py-2 font-medium">When</th>
                  <th className="px-3 py-2 font-medium">Property</th>
                  <th className="px-3 py-2 font-medium">What</th>
                  <th className="px-3 py-2 font-medium">From</th>
                </tr>
              </thead>
              <tbody className="divide-y">
                {changes.history.map((event) => (
                  <tr key={event.id}>
                    <td className="text-muted-foreground px-3 py-2 whitespace-nowrap tabular-nums">{formatDate(event.occurredAt)}</td>
                    <td className="px-3 py-2">
                      <PropertyLink address={event.address} buildingId={event.buildingId} />
                    </td>
                    <td className={cn('px-3 py-2', event.kind === 'JOINED' ? 'text-success' : 'text-warning')}>{eventText(event)}</td>
                    <td className="text-muted-foreground px-3 py-2">{eventSource(event)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        ) : (
          <EmptyState
            description="Nothing has moved a property into or out of the package since the history began."
            icon={HistoryIcon}
            title="No history yet"
          />
        )}
        {changes.historyMore ? (
          <p className="text-muted-foreground text-xs">{`And ${changes.historyMore.toLocaleString()} earlier, not listed.`}</p>
        ) : null}
      </section>
    </div>
  );
}

function Section({ icon, title, note, children }: { icon: ReactNode; title: string; note: string; children: ReactNode }) {
  return (
    <section aria-label={title} className="bg-card grid content-start gap-1 rounded-lg border px-3 py-2">
      <h3 className="flex items-center gap-2 text-sm font-medium">
        {icon}
        {title}
      </h3>
      <p className="text-muted-foreground text-xs">{note}</p>
      <ul className="max-h-[28rem] divide-y overflow-y-auto text-sm">{children}</ul>
    </section>
  );
}

function PropertyLink({ buildingId, address }: { buildingId: string; address: string }) {
  return (
    <Link className="font-medium hover:underline" href={`/properties/${buildingId}`}>
      {address}
    </Link>
  );
}

/** "Q3 2026: Aug 5 · Sam Tech · ● North". */
function Place({
  label,
  place,
  emphasis = false,
  suffix = null,
}: {
  label: string;
  place: QuarterVisitPlace;
  emphasis?: boolean;
  suffix?: string | null;
}) {
  return (
    <span className={cn('flex flex-wrap items-center gap-x-1.5 text-xs', emphasis ? 'text-warning' : 'text-muted-foreground')}>
      <span>{`${label}: ${placeText(place)}`}</span>
      {place.group ? <GroupName group={place.group} /> : null}
      {suffix ? <span>{`— ${suffix}`}</span> : null}
    </span>
  );
}

function GroupName({ group }: { group: QuarterDayGroup }) {
  return (
    <span className="inline-flex items-center gap-1">
      <span aria-hidden className="size-2.5 shrink-0 rounded-full" style={{ backgroundColor: group.color }} />
      {group.name}
    </span>
  );
}
