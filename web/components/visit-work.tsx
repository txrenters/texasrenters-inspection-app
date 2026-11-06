'use client';

import {
  REPORTABLE_VISIT_SERVICES,
  VISIT_SERVICE_LABEL,
  filterLabel,
  inspectionWords,
  installedFilters,
  type AdminInspection,
  type ReportableVisitService,
  type VisitFilterOutcome,
  type VisitServicesReport,
} from '@texasrenters/shared';
import { ChevronDownIcon } from 'lucide-react';
import type { ReactNode } from 'react';

import { ServicePhotos, type ServicePhoto } from '@/components/service-photos';
import { Badge } from '@/components/ui/badge';
import { formatDateTime } from '@/lib/format';

/**
 * What was done on a visit, as cards (the office, 2026-11-06: "arrange it with
 * cards or a dropdown when needed ... we will only show the title, like AC
 * filter change, pest control and others, cause we're going to add something
 * later").
 *
 * It was a list of services, then a count of filters, then the same filter
 * again and again under its photograph, with pest control between a filter
 * change and its filters. Now each thing done is one card: its title, a line
 * for a glance and how it went, and what there is to read in a dropdown.
 *
 * - A card with nothing more to show has no dropdown.
 * - A card that needs looking at opens by itself, so nobody clicks to find a
 *   problem.
 * - A service joins by being in `REPORTABLE_VISIT_SERVICES`: it gets the
 *   standard card with no change here. `SERVICE_CARDS` is only for a service
 *   with more to say.
 */

type CardStatus = { label: string; variant: 'secondary' | 'info' | 'success' | 'warning' };

export interface WorkCard {
  key: string;
  title: string;
  /** One line beside the title: what a glance needs. */
  summary: string | null;
  status: CardStatus;
  /** Something the office should see: the card opens by itself. */
  attention: boolean;
  /** What the dropdown holds; null for a card with nothing more to show. */
  details: ReactNode;
}

/** One card: its head alone, or its head as a dropdown when there is more to read. */
export function VisitFoldCard({
  title,
  summary,
  status,
  open = false,
  children,
}: {
  title: string;
  summary?: string | null;
  status?: CardStatus;
  open?: boolean;
  children?: ReactNode;
}) {
  const head = (
    <>
      {/* The line sits under the title on a phone, where beside it there was room for four letters. */}
      <span className="min-w-0 flex-1 sm:flex sm:items-baseline sm:gap-2">
        <span className="text-heading block shrink-0 font-medium">{title}</span>
        {summary ? <span className="text-muted-foreground block min-w-0 truncate text-xs">{summary}</span> : null}
      </span>
      {status ? <Badge variant={status.variant}>{status.label}</Badge> : null}
    </>
  );
  if (!children)
    return (
      <div className="flex items-center gap-2 rounded-lg border px-3 py-2.5 text-sm">
        {head}
        {/* Where the arrow sits on a card that has one, so the statuses line up. */}
        <span aria-hidden className="size-4 shrink-0" />
      </div>
    );
  return (
    <details className="group rounded-lg border text-sm" open={open}>
      <summary className="flex cursor-pointer list-none items-center gap-2 px-3 py-2.5 select-none [&::-webkit-details-marker]:hidden">
        {head}
        <ChevronDownIcon aria-hidden className="text-muted-foreground size-4 shrink-0 transition-transform group-open:rotate-180" />
      </summary>
      <div className="grid gap-3 border-t px-3 py-3">{children}</div>
    </details>
  );
}

/**
 * How long after the job was submitted a photograph still missing is called
 * missing rather than uploading. A phone in a cupboard with no signal sends it
 * when the signal returns, which is hours at most; days means it is not coming.
 */
const PHOTO_OVERDUE_MS = 24 * 60 * 60 * 1000;

/** "1 filter · 20x30x1", "3 filters · 2 × 20x25x1, 16x20x1": counted as the invoice counts them. */
export function filtersLine(report: VisitServicesReport): string | null {
  const installed = installedFilters(report);
  if (!installed.length) return null;
  const counts = new Map<string, number>();
  for (const size of installed) counts.set(size, (counts.get(size) ?? 0) + 1);
  const sizes = [...counts].map(([size, count]) => (count > 1 ? `${count} × ${size}` : size)).join(', ');
  return `${installed.length} filter${installed.length === 1 ? '' : 's'} · ${sizes}`;
}

/**
 * How a filter was scored on an HVAC job, as the report's row reads: "Clean Y ·
 * Undamaged N · Working Y · Not present". Empty for a filter nobody scored.
 */
function filterScore(filter: VisitFilterOutcome): string {
  const axis = (name: string, value: boolean | null | undefined) =>
    value == null ? null : `${name} ${value ? 'Y' : 'N'}`;
  return [axis('Clean', filter.isClean), axis('Undamaged', filter.isUndamaged), axis('Working', filter.isWorking), filter.comment?.trim() || null]
    .filter(Boolean)
    .join(' · ');
}

/** A filter that needs looking at: not changed, gone, a different size, or its photograph not here. */
function filterNeedsLooking(filter: VisitFilterOutcome) {
  if (filter.removed) return true;
  return !filter.changed || Boolean(filter.actualSize) || !filter.photoId;
}

/** One photograph of all the filters, stacked (the office, 2026-09-29): one thumbnail, named for each. */
function filterPhotos(report: VisitServicesReport): ServicePhoto[] {
  const byPhoto = new Map<string, string[]>();
  for (const filter of report.filters ?? []) {
    if (!filter.photoId) continue;
    byPhoto.set(filter.photoId, [...(byPhoto.get(filter.photoId) ?? []), filterLabel(filter)]);
  }
  return [...byPhoto].map(([id, labels]) => ({ id, label: labels.join(', '), captureType: 'SERIAL_OR_LABEL' }));
}

function FilterRegisters({ filters, overdue }: { filters: readonly VisitFilterOutcome[]; overdue: boolean }) {
  return (
    <ul aria-label="Filter registers" className="grid gap-1.5">
      {filters.map((filter) => (
        <li className="flex flex-wrap items-baseline gap-x-2 gap-y-1" key={`${filter.size}-${filter.location ?? ''}-${filter.slot}`}>
          {filter.removed ? (
            <Badge variant="outline">Not at the property</Badge>
          ) : (
            <Badge variant={filter.changed ? 'success' : 'warning'}>{filter.changed ? 'Changed' : 'Not changed'}</Badge>
          )}
          <span className={filter.removed ? 'line-through' : undefined}>
            {filterLabel(filter.removed ? { ...filter, actualSize: null } : filter)}
          </span>
          {filter.booked ? null : <Badge variant="outline">Found on site</Badge>}
          {/* The listed size the technician corrected: the office's record of
              this property is wrong until somebody fixes it. */}
          {filter.actualSize && !filter.removed ? <span className="text-muted-foreground text-xs">listed as {filter.size}</span> : null}
          {filter.reason ? <span className="text-muted-foreground">{filter.reason}</span> : null}
          {/* How it was found, on an HVAC job (Moses, 2026-10-01). */}
          {filterScore(filter) ? <span className="text-muted-foreground text-xs">{filterScore(filter)}</span> : null}
          {filter.changed && !filter.photoId && !filter.removed ? (
            overdue ? (
              <span className="text-destructive text-xs">Photograph never arrived</span>
            ) : (
              <span className="text-warning text-xs">Photograph still uploading</span>
            )
          ) : null}
        </li>
      ))}
    </ul>
  );
}

interface CardContext {
  /** A photograph still missing has stopped being on its way. */
  overdue: boolean;
}

/** What a service says beyond the standard card. A service not named here needs nothing from this. */
const SERVICE_CARDS: Partial<
  Record<ReportableVisitService, (report: VisitServicesReport, context: CardContext) => Pick<WorkCard, 'summary' | 'attention' | 'details'> | null>
> = {
  filterChange: (report, { overdue }) => {
    const filters = report.filters ?? [];
    const summary = filtersLine(report);
    if (!filters.length && !summary) return null;
    return {
      summary,
      attention: filters.some(filterNeedsLooking),
      details: filters.length ? (
        <>
          <FilterRegisters filters={filters} overdue={overdue} />
          <ServicePhotos areaName="this job" photos={filterPhotos(report)} />
        </>
      ) : null,
    };
  },
};

/** One service's card: how it went, why not, and its photograph, plus whatever more that service says. */
function serviceCard(service: ReportableVisitService, report: VisitServicesReport, context: CardContext): WorkCard | null {
  const outcome = report.services[service];
  const extra = SERVICE_CARDS[service]?.(report, context) ?? null;
  if (!outcome && !extra) return null;
  const done = outcome?.done ?? true;
  const photo: ServicePhoto[] = outcome?.photoId ? [{ id: outcome.photoId, label: VISIT_SERVICE_LABEL[service], captureType: 'OTHER' }] : [];
  const standard =
    outcome?.reason || photo.length ? (
      <>
        {outcome?.reason ? <p className="text-muted-foreground">{outcome.reason}</p> : null}
        <ServicePhotos areaName="this job" photos={photo} />
      </>
    ) : null;
  return {
    key: service,
    title: VISIT_SERVICE_LABEL[service],
    summary: extra?.summary ?? (outcome?.reschedule ? 'To reschedule' : null),
    status: done ? { label: 'Done', variant: 'success' } : { label: 'Not done', variant: 'warning' },
    attention: !done || Boolean(extra?.attention),
    details:
      standard || extra?.details ? (
        <>
          {standard}
          {extra?.details}
        </>
      ) : null,
  };
}

/** Every service the technician answered for, in the order the office lists them. */
export function serviceCards(report: VisitServicesReport, overdue: boolean): WorkCard[] {
  return REPORTABLE_VISIT_SERVICES.flatMap((service) => serviceCard(service, report, { overdue }) ?? []);
}

/** The inspection, once it is under way: the areas are read further down the page. */
function inspectionCard(inspection: AdminInspection, status: CardStatus, areas: VisitAreaCounts | null): WorkCard | null {
  if (inspection.inspectionType === 'AC_FILTER_DELIVERY') return null;
  return {
    key: 'inspection',
    title: inspectionWords(inspection.inspectionType),
    summary: areas ? `${areas.reviewed} of ${areas.total} areas reviewed` : null,
    status,
    attention: false,
    details: null,
  };
}

export interface VisitAreaCounts {
  reviewed: number;
  total: number;
}

/** The visit's work: every card, its services then the inspection, and anything else the technician wrote. */
export function VisitWork({
  inspection,
  report,
  status,
  areas,
  showInspection,
}: {
  inspection: AdminInspection;
  report: VisitServicesReport | null;
  /** How the visit stands, which is how its inspection stands. */
  status: CardStatus;
  areas: VisitAreaCounts | null;
  /** The inspection has begun, so there is something of it to speak of. */
  showInspection: boolean;
}) {
  const submittedAt = inspection.submittedAt ?? null;
  // "Still uploading" four days on told the office to wait for a photograph
  // that was never coming (5706 Micah Ln, 2026-10-02 to 10-06).
  const overdue = submittedAt ? Date.now() - Date.parse(submittedAt) > PHOTO_OVERDUE_MS : false;
  const cards = [
    ...(report ? serviceCards(report, overdue) : []),
    ...(showInspection ? [inspectionCard(inspection, status, areas)].filter((card): card is WorkCard => card !== null) : []),
  ];
  if (!cards.length && !report?.notes) return null;
  const reportedAt = inspection.servicesReportedAt ?? null;
  return (
    <section aria-label="Work done" className="grid gap-2">
      <h3 className="text-muted-foreground text-xs">
        Work done
        {reportedAt ? ` · reported ${formatDateTime(reportedAt)}` : ''}
      </h3>
      {cards.map((card) => (
        <VisitFoldCard key={card.key} open={card.attention} status={card.status} summary={card.summary} title={card.title}>
          {card.details}
        </VisitFoldCard>
      ))}
      {report?.notes ? <p className="text-sm whitespace-pre-wrap">{report.notes}</p> : null}
    </section>
  );
}
