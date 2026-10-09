'use client';

import { useState } from 'react';
import { AlertTriangleIcon, ChevronRightIcon, MonitorIcon, SmartphoneIcon } from 'lucide-react';

import { DataTableSkeleton, type Column } from '@/components/data-table';
import { ListToolbar } from '@/components/list-toolbar';
import { PageHeader } from '@/components/page-header';
import { Stat, StatGroup, StatGroupSkeleton } from '@/components/stat-card';
import { EmptyState, ErrorState } from '@/components/states';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { SegmentedControl } from '@/components/ui/segmented';
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '@/components/ui/table';
import { formatDateTime } from '@/lib/format';
import { useClientErrors, useClientErrorSummary, type ClientErrorReport } from '@/lib/queries';
import { useDebouncedValue } from '@/lib/use-debounced-value';
import { cn } from '@/lib/utils';

type Source = 'ALL' | 'MOBILE' | 'CONSOLE';

const SOURCES = [
  { value: 'ALL', label: 'Everything' },
  { value: 'MOBILE', label: 'Phones' },
  { value: 'CONSOLE', label: 'Console' },
] as const;

/** The table's shape while it loads, so the wait looks like what replaces it. */
const SKELETON_COLUMNS: Array<Column<ClientErrorReport>> = [
  { key: 'when', header: 'When', cell: () => null },
  { key: 'where', header: 'Where', cell: () => null },
  { key: 'what', header: 'What', cell: () => null },
  { key: 'build', header: 'Build', hideBelow: 'md', cell: () => null },
];

/**
 * Errors from the handset and from this console, in one place.
 *
 * Neither used to reach anybody. The phone kept a twenty-entry log that never
 * left the device, and the console kept nothing at all — a production React
 * error was a minified digest in one person's devtools, and a technician's
 * crash was whatever they remembered to mention. Two separate afternoons this
 * month went on errors that were, in the end, visible only to the person who
 * could not read them.
 *
 * Everything below is client-supplied text. It is rendered as text and never as
 * markup, and both the client and the server strip credential-shaped strings
 * before it is stored.
 *
 * On the console's design system since console-development: the page header,
 * one figure panel, the list toolbar and the table every list uses. Times are
 * Texas time, as everywhere else; `toLocaleString` printed them in the
 * reader's zone, hours off from the schedule they were being compared with.
 */
export default function ClientErrorLogPage() {
  const [source, setSource] = useState<Source>('ALL');
  const [fatalOnly, setFatalOnly] = useState(false);
  const [search, setSearch] = useState('');
  const [expanded, setExpanded] = useState<string | null>(null);
  const term = useDebouncedValue(search.trim());

  const summary = useClientErrorSummary();
  const errors = useClientErrors({
    ...(source === 'ALL' ? {} : { source }),
    ...(fatalOnly ? { fatalOnly: true } : {}),
    ...(term ? { search: term } : {}),
    take: 100,
  });

  const filtered = Boolean(term || fatalOnly || source !== 'ALL');
  const clear = () => {
    setSource('ALL');
    setFatalOnly(false);
    setSearch('');
  };
  const count = errors.data?.items.length ?? 0;

  return (
    <>
      <PageHeader
        description="What went wrong on a technician’s phone or in this console."
        info={
          <>
            <p>
              Reports arrive even when nobody is signed in, which is when they matter most.
            </p>
            <p>
              Everything here is text the phone or the browser sent. Credential-shaped strings are
              stripped on both ends before it is stored.
            </p>
          </>
        }
        infoLabel="About the error log"
        title="Error log"
      />

      {summary.data ? (
        <StatGroup className="mb-4" columns="grid-cols-2 sm:grid-cols-4">
          <Stat label="Last 24 hours" value={summary.data.lastDay.toLocaleString()} />
          {/* The dot, not a red figure: the count is what is read, and the
              tone only says it wants a person (console-development). */}
          <Stat
            label="Crashes (24h)"
            tone={summary.data.fatalLastDay > 0 ? 'destructive' : 'default'}
            value={summary.data.fatalLastDay.toLocaleString()}
          />
          <Stat label="From phones (24h)" value={summary.data.mobileLastDay.toLocaleString()} />
          <Stat label="From console (24h)" value={summary.data.consoleLastDay.toLocaleString()} />
        </StatGroup>
      ) : summary.isLoading ? (
        <div className="mb-4">
          <StatGroupSkeleton columns="grid-cols-2 sm:grid-cols-4" count={4} />
        </div>
      ) : null}

      <ListToolbar
        activeFilters={[
          ...(source !== 'ALL'
            ? [
                {
                  label: 'Source',
                  value: source === 'MOBILE' ? 'Phones' : 'Console',
                  onRemove: () => setSource('ALL'),
                },
              ]
            : []),
          ...(fatalOnly
            ? [{ label: 'Showing', value: 'Crashes only', onRemove: () => setFatalOnly(false) }]
            : []),
        ]}
        filters={
          <>
            <SegmentedControl
              aria-label="Where the error happened"
              onChange={setSource}
              options={SOURCES}
              value={source}
            />
            {/* A real toggle that says whether it is on; the ink fill that
                marked it was the same as a primary button's. */}
            <Button
              aria-pressed={fatalOnly}
              className={cn(fatalOnly && 'bg-highlight/10 text-highlight hover:bg-highlight/15 hover:text-highlight')}
              onClick={() => setFatalOnly((on) => !on)}
              size="sm"
              variant="outline"
            >
              Crashes only
            </Button>
          </>
        }
        onClear={clear}
        onSearch={setSearch}
        pending={search.trim() !== term}
        resultLabel={
          errors.isLoading
            ? 'Loading reports…'
            : errors.isError && !errors.data
              ? 'Reports could not be loaded'
              : `${count.toLocaleString()} report${count === 1 ? '' : 's'}${count >= 100 ? ' (latest 100)' : ''}`
        }
        search={search}
        searchLabel="Search error reports"
        searchPlaceholder="Search message, context or API host"
      />

      {errors.isLoading ? (
        <DataTableSkeleton columns={SKELETON_COLUMNS} label="Loading error reports" rows={6} />
      ) : errors.isError && !errors.data ? (
        // A failed request is not "Nothing reported yet" (console-development):
        // that sentence over a dead endpoint read as all-clear.
        <ErrorState error={errors.error} retry={() => void errors.refetch()} />
      ) : errors.data && errors.data.items.length > 0 ? (
        <div className="bg-card overflow-clip rounded-xl border">
          <Table aria-label="Error reports">
            <TableHeader>
              <TableRow className="hover:bg-transparent">
                <TableHead className="w-[11rem]" scope="col">
                  When
                </TableHead>
                <TableHead className="w-[6rem]" scope="col">
                  Where
                </TableHead>
                <TableHead scope="col">What</TableHead>
                <TableHead className="hidden w-[14rem] md:table-cell" scope="col">
                  Build
                </TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {errors.data.items.map((report) => (
                <ErrorRow
                  expanded={expanded === report.id}
                  key={report.id}
                  onToggle={() => setExpanded(expanded === report.id ? null : report.id)}
                  report={report}
                />
              ))}
            </TableBody>
          </Table>
        </div>
      ) : (
        <EmptyState
          description={
            filtered ? 'Nothing matches these filters.' : 'Errors from phones and this console appear here.'
          }
          title={filtered ? 'Nothing reported for this filter' : 'Nothing reported yet'}
        >
          {filtered ? (
            <Button onClick={clear} variant="outline">
              Clear filters
            </Button>
          ) : null}
        </EmptyState>
      )}
    </>
  );
}

function ErrorRow({
  expanded,
  onToggle,
  report,
}: {
  expanded: boolean;
  onToggle: () => void;
  report: ClientErrorReport;
}) {
  const detailsId = `error-${report.id}-details`;
  return (
    <>
      {/* The row still opens on a click, for the mouse; the chevron is the
          control a keyboard and a screen reader can reach (console-development). */}
      <TableRow className="cursor-pointer" onClick={onToggle}>
        <TableCell className="font-mono text-xs whitespace-nowrap">
          <span className="flex items-center gap-1">
            <Button
              aria-controls={expanded ? detailsId : undefined}
              aria-expanded={expanded}
              aria-label={expanded ? 'Hide details' : 'Show details'}
              className="-ml-2 size-7"
              onClick={(event) => {
                event.stopPropagation();
                onToggle();
              }}
              size="icon"
              variant="ghost"
            >
              <ChevronRightIcon className={cn('transition-transform', expanded && 'rotate-90')} />
            </Button>
            {formatDateTime(report.receivedAt)}
          </span>
        </TableCell>
        <TableCell>
          <span className="flex items-center gap-1 text-xs">
            {report.source === 'MOBILE' ? (
              <SmartphoneIcon aria-hidden className="size-3" />
            ) : (
              <MonitorIcon aria-hidden className="size-3" />
            )}
            {report.source === 'MOBILE' ? 'Phone' : 'Console'}
          </span>
        </TableCell>
        <TableCell className="whitespace-normal">
          <div className="flex items-start gap-2">
            {report.fatal ? (
              <Badge variant="destructive">
                <AlertTriangleIcon className="size-3" />
                Crash
              </Badge>
            ) : null}
            <div className="min-w-0">
              {/* Client text, rendered as text. Never dangerouslySetInnerHTML. */}
              <div className="line-clamp-2 text-sm break-words">{report.message}</div>
              {report.context ? (
                <div className="text-muted-foreground font-mono text-xs break-all">{report.context}</div>
              ) : null}
            </div>
          </div>
        </TableCell>
        <TableCell className="hidden font-mono text-xs md:table-cell">
          {[report.platform, report.appVersion].filter(Boolean).join(' ') || '—'}
        </TableCell>
      </TableRow>
      {expanded ? (
        <TableRow className="hover:bg-transparent" id={detailsId}>
          <TableCell className="bg-muted/40 whitespace-normal" colSpan={4}>
            <dl className="grid gap-1 text-xs sm:grid-cols-2">
              <Detail label="Message">{report.message}</Detail>
              {/* The field that would have answered an afternoon's question in
                  one glance: which host this build was actually calling. */}
              <Detail label="API host">{report.apiBaseUrl ?? '—'}</Detail>
              <Detail label="Happened">{formatDateTime(report.occurredAt)}</Detail>
              <Detail label="Install">{report.installId}</Detail>
              {/* The Build column folds away on a phone; its words stay here. */}
              <Detail label="App">
                {[report.platform, report.appVersion].filter(Boolean).join(' ') || '—'}
              </Detail>
              <Detail label="Build">{report.buildId ?? '—'}</Detail>
              <Detail label="Signed in as">{report.authUserId ?? 'nobody'}</Detail>
            </dl>
            {report.stack ? (
              <pre className="bg-background mt-3 overflow-x-auto rounded border p-2 font-mono text-xs">
                {report.stack}
              </pre>
            ) : null}
          </TableCell>
        </TableRow>
      ) : null}
    </>
  );
}

function Detail({ children, label }: { children: React.ReactNode; label: string }) {
  return (
    <div className="flex gap-2">
      <dt className="text-muted-foreground shrink-0">{label}:</dt>
      <dd className="min-w-0 font-mono break-all">{children}</dd>
    </div>
  );
}
