'use client';

import type { GroupTemplateChanges, PackageChangeGroup } from '@texasrenters/shared';
import { ChevronDownIcon, MapPinOffIcon, UserMinusIcon, UserPlusIcon } from 'lucide-react';
import { useState, type ReactNode } from 'react';

import { Button } from '@/components/ui/button';
import { formatDate } from '@/lib/format';
import { cn } from '@/lib/utils';

import { addedText, changesSummary, leftReasonText, roomText, suggestionTitle } from './package-changes';

/**
 * What changed in the benefit package under the open template (the office,
 * 2026-10-15): "we should have a way to know if a property has opted out or
 * left the TBP ... where was that, what group", and for one that joined, "a
 * suggestion where or what group we can let it grouped based on the driving
 * time".
 *
 * Above the map rather than a passing toast: a leaver is not drawn, so this is
 * the only place it can be found; a newcomer is drawn in no group's colour, and
 * this says which groups it would fit.
 */
export function PackageChangesPanel({
  changes,
  canChange,
  busy,
  onAdd,
  onRemove,
}: {
  changes: GroupTemplateChanges;
  canChange: boolean;
  /** Properties with a change on its way: their buttons wait for it. */
  busy: ReadonlySet<string>;
  /** Put a newcomer in a group, at the end of its order: reorder on the map as usual. */
  onAdd: (buildingId: string, group: PackageChangeGroup) => void;
  /** Take a leaver out of the group it is still in. */
  onRemove: (buildingId: string, group: PackageChangeGroup) => void;
}) {
  const [open, setOpen] = useState(true);
  const summary = changesSummary(changes);
  if (!summary)
    return (
      <p className="text-muted-foreground text-xs" role="status">
        Benefit package: every property in it is in a group, and none of the template&rsquo;s has left.
      </p>
    );

  return (
    <section aria-label="Benefit package changes" className="bg-card rounded-lg border">
      <button
        aria-expanded={open}
        className="hover:bg-accent/40 flex w-full flex-wrap items-center gap-x-3 gap-y-1 rounded-lg px-3 py-2 text-left text-sm"
        onClick={() => setOpen((was) => !was)}
        type="button"
      >
        <span className="font-medium">Benefit package changes</span>
        <span className="text-muted-foreground text-xs">{summary}</span>
        <ChevronDownIcon aria-hidden className={cn('text-muted-foreground ml-auto size-4 transition-transform', open && 'rotate-180')} />
      </button>
      {open ? (
        <div className="grid gap-4 border-t px-3 py-3 lg:grid-cols-2">
          {changes.newcomers.length ? (
            <Section
              icon={<UserPlusIcon aria-hidden className="text-success size-4" />}
              note="Each is offered the groups it adds the least driving to, nearest first. Left here, a quarter built from this template puts it in the nearest group with room by itself."
              title={`New in the package, not in a group (${changes.newcomers.length.toLocaleString()})`}
            >
              {changes.newcomers.map((newcomer) => (
                <li className="grid gap-1.5 py-2" key={newcomer.buildingId}>
                  <div className="flex flex-wrap items-baseline gap-x-2 gap-y-0.5">
                    <span className="font-medium">{newcomer.address}</span>
                    <span className="text-muted-foreground text-xs">
                      {[
                        newcomer.city,
                        newcomer.zone ? `Zone ${newcomer.zone}` : null,
                        newcomer.firstOnReport ? `on the tenant report since ${formatDate(newcomer.firstOnReport)}` : null,
                      ]
                        .filter(Boolean)
                        .join(' · ')}
                    </span>
                  </div>
                  {newcomer.suggestions.length ? (
                    <div className="flex flex-wrap items-center gap-1.5">
                      <span className="text-muted-foreground text-xs">Fits:</span>
                      {newcomer.suggestions.map((suggestion) => (
                        <Button
                          aria-label={`Add ${newcomer.address} to ${suggestion.group.name}`}
                          className="h-7 gap-1.5 px-2 text-xs"
                          disabled={!canChange || busy.has(newcomer.buildingId)}
                          key={suggestion.group.id}
                          onClick={() => onAdd(newcomer.buildingId, suggestion.group)}
                          size="sm"
                          title={suggestionTitle(suggestion)}
                          type="button"
                          variant="outline"
                        >
                          <GroupDot group={suggestion.group} />
                          <span className="font-medium">{suggestion.group.name}</span>
                          <span className="text-muted-foreground tabular-nums">{addedText(suggestion)}</span>
                          <span className={cn('tabular-nums', suggestion.hasRoom ? 'text-muted-foreground' : 'text-warning')}>
                            {roomText(suggestion)}
                          </span>
                          {suggestion.timing === 'ESTIMATE' ? <span className="text-muted-foreground">≈</span> : null}
                        </Button>
                      ))}
                    </div>
                  ) : (
                    <span className="text-muted-foreground text-xs">No group has a property to measure from yet.</span>
                  )}
                </li>
              ))}
            </Section>
          ) : null}

          {changes.leavers.length ? (
            <Section
              icon={<UserMinusIcon aria-hidden className="text-warning size-4" />}
              note="Not on the map and not visited: a quarter leaves them out. They stay in their group until taken out, and come back by themselves if they rejoin."
              title={`Left the package, still in a group (${changes.leavers.length.toLocaleString()})`}
            >
              {changes.leavers.map((leaver) => (
                <li className="flex flex-wrap items-center gap-x-3 gap-y-1 py-2" key={leaver.buildingId}>
                  <div className="grid min-w-0 flex-1 gap-0.5">
                    <div className="flex flex-wrap items-baseline gap-x-2">
                      <span className="font-medium">{leaver.address}</span>
                      <GroupName group={leaver.group} />
                    </div>
                    <span className="text-muted-foreground text-xs">
                      {leaver.reasons.length ? leaver.reasons.map(leftReasonText).join('; ') : 'No longer in the package'}
                    </span>
                  </div>
                  {canChange ? (
                    <Button
                      aria-label={`Take ${leaver.address} out of ${leaver.group.name}`}
                      className="h-7 px-2 text-xs"
                      disabled={busy.has(leaver.buildingId)}
                      onClick={() => onRemove(leaver.buildingId, leaver.group)}
                      size="sm"
                      type="button"
                      variant="ghost"
                    >
                      Take out of {leaver.group.name}
                    </Button>
                  ) : null}
                </li>
              ))}
            </Section>
          ) : null}

          {changes.unplaced.length ? (
            <Section
              icon={<MapPinOffIcon aria-hidden className="text-muted-foreground size-4" />}
              note="Still in the package and still visited, but with no position yet the map cannot draw them. Correct the address or its pin on the property's page."
              title={`In a group, no position on the map (${changes.unplaced.length.toLocaleString()})`}
            >
              {changes.unplaced.map((member) => (
                <li className="flex flex-wrap items-baseline gap-x-2 py-2" key={member.buildingId}>
                  <span className="font-medium">{member.address}</span>
                  <GroupName group={member.group} />
                </li>
              ))}
            </Section>
          ) : null}
        </div>
      ) : null}
    </section>
  );
}

function Section({ icon, title, note, children }: { icon: ReactNode; title: string; note: string; children: ReactNode }) {
  return (
    <div className="grid content-start gap-1">
      <h3 className="flex items-center gap-2 text-sm font-medium">
        {icon}
        {title}
      </h3>
      <p className="text-muted-foreground text-xs">{note}</p>
      <ul className="max-h-80 divide-y overflow-y-auto text-sm">{children}</ul>
    </div>
  );
}

/** A group's colour, as the map draws it. */
function GroupDot({ group }: { group: PackageChangeGroup }) {
  return <span aria-hidden className="size-2.5 shrink-0 rounded-full" style={{ backgroundColor: group.color }} />;
}

function GroupName({ group }: { group: PackageChangeGroup }) {
  return (
    <span className="text-muted-foreground inline-flex items-center gap-1.5 text-xs">
      <GroupDot group={group} />
      {group.name}
    </span>
  );
}
