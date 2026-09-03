'use client';

import { useState } from 'react';
import { AlertTriangleIcon, MonitorIcon, SmartphoneIcon } from 'lucide-react';

import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Spinner } from '@/components/ui/spinner';
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '@/components/ui/table';
import { useClientErrors, useClientErrorSummary, type ClientErrorReport } from '@/lib/queries';

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
 */
export default function ClientErrorLogPage() {
  const [source, setSource] = useState<'ALL' | 'MOBILE' | 'CONSOLE'>('ALL');
  const [fatalOnly, setFatalOnly] = useState(false);
  const [search, setSearch] = useState('');
  const [expanded, setExpanded] = useState<string | null>(null);

  const summary = useClientErrorSummary();
  const errors = useClientErrors({
    ...(source === 'ALL' ? {} : { source }),
    ...(fatalOnly ? { fatalOnly: true } : {}),
    ...(search.trim() ? { search: search.trim() } : {}),
    take: 100,
  });

  return (
    <div className="space-y-4 p-6">
      <div>
        <h1 className="text-xl font-semibold">Error log</h1>
        <p className="text-muted-foreground text-sm">
          What went wrong on a technician&rsquo;s phone or in this console. Reports arrive even when
          nobody is signed in, which is when they matter most.
        </p>
      </div>

      {summary.data ? (
        <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
          <Stat label="Last 24 hours" value={summary.data.lastDay} />
          <Stat label="Crashes (24h)" value={summary.data.fatalLastDay} tone="destructive" />
          <Stat label="From phones (24h)" value={summary.data.mobileLastDay} />
          <Stat label="From console (24h)" value={summary.data.consoleLastDay} />
        </div>
      ) : null}

      <div className="flex flex-wrap items-center gap-2">
        {(['ALL', 'MOBILE', 'CONSOLE'] as const).map((option) => (
          <Button
            key={option}
            onClick={() => setSource(option)}
            size="sm"
            variant={source === option ? 'default' : 'outline'}
          >
            {option === 'ALL' ? 'Everything' : option === 'MOBILE' ? 'Phones' : 'Console'}
          </Button>
        ))}
        <Button
          onClick={() => setFatalOnly((on) => !on)}
          size="sm"
          variant={fatalOnly ? 'default' : 'outline'}
        >
          Crashes only
        </Button>
        <Input
          className="max-w-xs"
          onChange={(event) => setSearch(event.target.value)}
          placeholder="Search message, context or API host"
          value={search}
        />
      </div>

      {errors.isLoading ? (
        <p className="text-muted-foreground flex items-center gap-2 text-sm">
          <Spinner /> Loading…
        </p>
      ) : errors.data && errors.data.items.length > 0 ? (
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead className="w-[9rem]">When</TableHead>
              <TableHead className="w-[6rem]">Where</TableHead>
              <TableHead>What</TableHead>
              <TableHead className="w-[14rem]">Build</TableHead>
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
      ) : (
        <p className="text-muted-foreground text-sm">
          Nothing reported{search || fatalOnly || source !== 'ALL' ? ' for this filter' : ' yet'}.
        </p>
      )}
    </div>
  );
}

function Stat({
  label,
  value,
  tone,
}: {
  label: string;
  value: number;
  tone?: 'destructive';
}) {
  return (
    <div className="rounded-md border p-3">
      <div className="text-muted-foreground text-xs">{label}</div>
      <div
        className={`font-mono text-lg ${tone === 'destructive' && value > 0 ? 'text-destructive' : ''}`}
      >
        {value}
      </div>
    </div>
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
  return (
    <>
      <TableRow className="cursor-pointer" onClick={onToggle}>
        <TableCell className="font-mono text-xs whitespace-nowrap">
          {new Date(report.receivedAt).toLocaleString()}
        </TableCell>
        <TableCell>
          <span className="flex items-center gap-1 text-xs">
            {report.source === 'MOBILE' ? (
              <SmartphoneIcon className="size-3" />
            ) : (
              <MonitorIcon className="size-3" />
            )}
            {report.source === 'MOBILE' ? 'Phone' : 'Console'}
          </span>
        </TableCell>
        <TableCell>
          <div className="flex items-start gap-2">
            {report.fatal ? (
              <Badge variant="destructive">
                <AlertTriangleIcon className="size-3" />
                crash
              </Badge>
            ) : null}
            <div className="min-w-0">
              {/* Client text, rendered as text. Never dangerouslySetInnerHTML. */}
              <div className="truncate text-sm">{report.message}</div>
              {report.context ? (
                <div className="text-muted-foreground font-mono text-xs">{report.context}</div>
              ) : null}
            </div>
          </div>
        </TableCell>
        <TableCell className="font-mono text-xs">
          {[report.platform, report.appVersion].filter(Boolean).join(' ') || '—'}
        </TableCell>
      </TableRow>
      {expanded ? (
        <TableRow>
          <TableCell className="bg-muted/40" colSpan={4}>
            <dl className="grid gap-1 text-xs sm:grid-cols-2">
              <Detail label="Message">{report.message}</Detail>
              {/* The field that would have answered an afternoon's question in
                  one glance: which host this build was actually calling. */}
              <Detail label="API host">{report.apiBaseUrl ?? '—'}</Detail>
              <Detail label="Happened">{new Date(report.occurredAt).toLocaleString()}</Detail>
              <Detail label="Install">{report.installId}</Detail>
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
