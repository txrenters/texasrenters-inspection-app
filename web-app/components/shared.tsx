'use client';

import Link from 'next/link';
import { useEffect, useState, type ReactNode } from 'react';

import { cn } from '@/lib/utils';

import { Button } from './ui/button';
import { Card } from './ui/card';
import { Skeleton } from './ui/skeleton';
import { StatusBadge } from './status-badge';

/**
 * Shared primitives, migrated onto Tailwind + shadcn.
 *
 * Every page imports from here, so porting these internals migrates the app
 * without touching the 22 route files. The exported signatures are unchanged.
 *
 * Legacy class names are **removed** from migrated components on purpose:
 * `globals.css` is unlayered while Tailwind utilities live in `@layer
 * utilities`, and unlayered rules win the cascade. Keeping both would let the
 * old CSS silently override every utility here.
 *
 * `BrandLoader` deliberately keeps its legacy classes — it is a bespoke
 * animated brand mark, not a shadcn primitive, and translating its keyframes to
 * utilities would add risk with nothing to gain. It migrates in the final pass.
 */

export function PageHeader({
  title,
  description,
  action,
  breadcrumbs,
}: {
  title: string;
  description?: string;
  action?: ReactNode;
  breadcrumbs?: Array<{ label: string; href?: string }>;
}) {
  return (
    <header className="mb-5">
      {breadcrumbs?.length ? (
        <nav
          aria-label="Breadcrumb"
          className="mb-2 flex flex-wrap items-center gap-1.5 text-xs text-muted-foreground"
        >
          {breadcrumbs.map((item, index) => (
            <span key={`${item.label}-${index}`} className="inline-flex items-center gap-1.5">
              {index ? <span aria-hidden>/</span> : null}
              {item.href ? (
                <Link href={item.href} className="text-primary hover:underline">
                  {item.label}
                </Link>
              ) : (
                <span>{item.label}</span>
              )}
            </span>
          ))}
        </nav>
      ) : null}
      <div className="flex flex-wrap items-start justify-between gap-4">
        <div>
          <span className="mb-1.5 block text-[10px] font-extrabold uppercase tracking-[0.12em] text-primary">
            TexasRenters operations
          </span>
          <h1 className="m-0 text-2xl font-bold leading-tight">{title}</h1>
          {description ? (
            <p className="mt-2 max-w-[760px] text-[13px] text-muted-foreground">{description}</p>
          ) : null}
        </div>
        {action}
      </div>
    </header>
  );
}

/**
 * Kept as a thin alias so the ~40 existing call sites keep working while the
 * status system becomes authoritative. Prefer importing StatusBadge directly.
 *
 * The old implementation guessed a tone by regex-matching the status text,
 * which is why "Approved" and "Completed" could disagree between screens.
 * StatusBadge maps each status explicitly instead.
 */
export function Badge({ value, pulse }: { value: string; pulse?: boolean }) {
  return <StatusBadge value={value} showIcon={!pulse} />;
}

const METRIC_ACCENTS = {
  blue: 'before:bg-[var(--blue)]',
  green: 'before:bg-[var(--green)]',
  warning: 'before:bg-[var(--warning)]',
  danger: 'before:bg-[var(--danger)]',
  neutral: 'before:bg-[var(--border)]',
} as const;

export function MetricCard({
  label,
  value,
  detail,
  tone = 'blue',
}: {
  label: string;
  value: number | string;
  detail?: string;
  tone?: 'blue' | 'green' | 'warning' | 'danger' | 'neutral';
}) {
  return (
    <article
      className={cn(
        'relative grid gap-1 overflow-hidden rounded-xl border border-border bg-card',
        'px-[18px] pt-[18px] pb-[17px] shadow-[var(--shadow-sm)]',
        // Left accent rail, matching the legacy ::before treatment.
        "before:absolute before:inset-y-0 before:left-0 before:w-[3px] before:content-['']",
        METRIC_ACCENTS[tone],
      )}
    >
      <span className="text-[11px] font-semibold text-muted-foreground">{label}</span>
      <strong className="text-2xl leading-none">{value}</strong>
      {detail ? <small className="text-[11px] text-muted-foreground">{detail}</small> : null}
    </article>
  );
}

export function FilterToolbar({
  children,
  resultLabel,
  onClear,
}: {
  children: ReactNode;
  resultLabel: string;
  onClear?: () => void;
}) {
  return (
    <section
      className="mb-4 rounded-xl border border-border bg-[var(--surface-subtle)] p-3"
      aria-label="List filters"
    >
      <div className="flex flex-wrap items-center gap-2">{children}</div>
      <div
        className="mt-2.5 flex flex-wrap items-center justify-between gap-3 text-xs text-muted-foreground"
        aria-live="polite"
      >
        <span className="font-bold">{resultLabel}</span>
        {onClear ? (
          <Button variant="link" size="small" onClick={onClear} type="button">
            Clear filters
          </Button>
        ) : (
          <span>Showing the latest available data</span>
        )}
      </div>
    </section>
  );
}

export function LoadingState({ label = 'Loading data…' }: { label?: string }) {
  return (
    <Card
      className="grid min-h-[360px] place-content-center gap-6 overflow-hidden p-6 text-center"
      aria-busy="true"
      aria-live="polite"
    >
      <BrandLoader label={label} />
      <div className="grid justify-items-center gap-2" aria-hidden="true">
        <Skeleton className="h-2.5 w-[220px]" />
        <Skeleton className="h-2.5 w-[160px]" />
      </div>
    </Card>
  );
}

export function BrandLoader({ label = 'Preparing your workspace' }: { label?: string }) {
  return (
    <div className="brand-loader" role="status" aria-label={label}>
      <span className="brand-loader-stage" aria-hidden="true">
        <span className="brand-loader-halo" />
        <span className="brand-loader-orbit">
          <span className="brand-loader-dot" />
        </span>
        <span className="brand-loader-core">
          <span className="brand-loader-mark">★</span>
        </span>
      </span>
      <span className="brand-loader-copy">
        <span className="brand-loader-eyebrow">TEXASRENTERS</span>
        <strong>{label}</strong>
      </span>
    </div>
  );
}

export function TableLoadingState({
  headers,
  rows = 6,
  label = 'Loading records',
}: {
  headers: string[];
  rows?: number;
  label?: string;
}) {
  const [showSkeleton, setShowSkeleton] = useState(false);

  // A brief brand loader first: flashing a skeleton for a request that resolves
  // in 200ms reads as jank rather than progress.
  useEffect(() => {
    const timer = window.setTimeout(() => setShowSkeleton(true), 350);
    return () => window.clearTimeout(timer);
  }, []);

  if (!showSkeleton) {
    return (
      <Card className="grid place-content-center p-8" aria-live="polite">
        <BrandLoader label={label} />
      </Card>
    );
  }

  return (
    <div className="overflow-auto rounded-2xl border border-border bg-card" aria-busy="true">
      <table aria-label={label}>
        <thead>
          <tr>
            {headers.map((header) => (
              <th key={header} scope="col">
                {header}
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {Array.from({ length: rows }, (_, rowIndex) => (
            <tr key={rowIndex}>
              {headers.map((header, columnIndex) => (
                <td key={header}>
                  <Skeleton
                    className="h-2.5"
                    style={{ width: `${Math.max(38, 82 - ((rowIndex + columnIndex) % 4) * 12)}%` }}
                  />
                </td>
              ))}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

function StatePanel({
  icon,
  title,
  children,
  role,
}: {
  icon: string;
  title: string;
  children: ReactNode;
  role?: 'alert';
}) {
  return (
    <Card className="grid justify-items-center gap-3 px-6 py-[52px] text-center" role={role}>
      <div
        className="grid size-10 place-content-center rounded-full bg-muted text-lg font-bold text-muted-foreground"
        aria-hidden
      >
        {icon}
      </div>
      <h2 className="m-0 text-base font-bold">{title}</h2>
      {children}
    </Card>
  );
}

export function ErrorState({ error, retry }: { error: unknown; retry: () => void }) {
  return (
    <StatePanel icon="!" title="Data could not be loaded" role="alert">
      <p className="m-0 max-w-[520px] text-[13px] text-muted-foreground">
        {error instanceof Error ? error.message : 'An unexpected error occurred.'}
      </p>
      <Button variant="secondary" onClick={retry}>
        Retry
      </Button>
    </StatePanel>
  );
}

export function EmptyState({
  title,
  description,
  action,
}: {
  title: string;
  description: string;
  action?: ReactNode;
}) {
  return (
    <StatePanel icon="◇" title={title}>
      <p className="m-0 max-w-[520px] text-[13px] text-muted-foreground">{description}</p>
      {action}
    </StatePanel>
  );
}

export function Pagination({
  page,
  totalPages,
  onPage,
}: {
  page: number;
  totalPages: number;
  onPage: (page: number) => void;
}) {
  if (totalPages <= 1) return null;
  return (
    <nav className="mt-4 flex items-center justify-end gap-3" aria-label="Pagination">
      <Button variant="secondary" disabled={page <= 1} onClick={() => onPage(page - 1)}>
        Previous
      </Button>
      <span className="text-xs text-muted-foreground">
        Page {page} of {totalPages}
      </span>
      <Button variant="secondary" disabled={page >= totalPages} onClick={() => onPage(page + 1)}>
        Next
      </Button>
    </nav>
  );
}

export function DataTable({
  headers,
  children,
  label,
}: {
  headers: string[];
  children: ReactNode;
  label?: string;
}) {
  return (
    <div className="overflow-auto rounded-2xl border border-border bg-card">
      <table aria-label={label}>
        <thead>
          <tr>
            {headers.map((header) => (
              <th key={header} scope="col">
                {header}
              </th>
            ))}
          </tr>
        </thead>
        <tbody>{children}</tbody>
      </table>
    </div>
  );
}

export const formatDate = (value?: string | Date | null) =>
  value
    ? new Intl.DateTimeFormat('en-US', { dateStyle: 'medium', timeStyle: 'short' }).format(
        new Date(value),
      )
    : 'Not provided';
export const address = (item?: {
  addressLine1?: string | null;
  city?: string | null;
  state?: string | null;
}) =>
  item
    ? [item.addressLine1, item.city, item.state].filter(Boolean).join(', ') || 'Not provided'
    : 'Not provided';
