'use client';

import { SECTION_LABEL } from '@/components/panel';

/**
 * The office's rules for laying out a quarter, and this quarter's own facts,
 * behind one ⓘ (the office, 2026-10-05: the paragraph and the strip of rules
 * above every plan were noise). Nothing here is acted on, so nothing here is
 * left on the page.
 *
 * The ⓘ itself is the page header's own (console-development): this is what
 * goes in it, the header supplying the button and the "How days are built"
 * label, so the plan's rules open the way every other page's do.
 */
export function PlanRules({
  minStopsPerDay,
  maxStopsPerDay,
  maxLegMinutes,
  facts,
}: {
  minStopsPerDay: number;
  maxStopsPerDay: number;
  maxLegMinutes: number;
  /** "First day", "US holidays", "Crew"… with what this quarter has for each. */
  facts: readonly { label: string; value: string }[];
}) {
  return (
    <>
      <ul className="text-muted-foreground grid list-disc gap-1 pl-4">
        <li>
          {minStopsPerDay} visits a day, up to {maxStopsPerDay} where the properties are within 5 minutes of each other.
        </li>
        <li>Never more than {maxLegMinutes} minutes from one property to the next.</li>
        <li>A property within 5 minutes of a group joins it, whatever its zone.</li>
        <li>A move-out or move-in takes the place of 3 visits.</li>
        <li>Each technician works their own zone each day and moves one zone on the next, furthest from downtown first.</li>
        <li>A zone too far for a day’s drive is a trip of days in a row for whoever lives nearest.</li>
        <li>Weekdays only. US holidays are off; Mondays from week 2 are kept free for rescheduled visits.</li>
      </ul>
      {facts.length ? (
        <section className="grid gap-1.5 border-t pt-3">
          <h2 className={SECTION_LABEL}>This quarter</h2>
          <dl className="grid grid-cols-[auto_minmax(0,1fr)] gap-x-3 gap-y-1">
            {facts.map((fact) => (
              <div className="contents" key={fact.label}>
                <dt className="text-muted-foreground">{fact.label}</dt>
                <dd>{fact.value}</dd>
              </div>
            ))}
          </dl>
        </section>
      ) : null}
    </>
  );
}
