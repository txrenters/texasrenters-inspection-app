'use client';

import Link from 'next/link';
import { useEffect, useState, type ReactNode } from 'react';

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
    <header className="page-header">
      {breadcrumbs?.length ? (
        <nav aria-label="Breadcrumb" className="breadcrumbs">
          {breadcrumbs.map((item, index) => (
            <span key={`${item.label}-${index}`}>
              {index ? <span aria-hidden>/</span> : null}
              {item.href ? <Link href={item.href}>{item.label}</Link> : <span>{item.label}</span>}
            </span>
          ))}
        </nav>
      ) : null}
      <div className="page-heading">
        <div>
          <span className="page-eyebrow">TexasRenters operations</span>
          <h1>{title}</h1>
          {description ? <p>{description}</p> : null}
        </div>
        {action}
      </div>
    </header>
  );
}

export function Badge({ value }: { value: string }) {
  const normalized = value.toLowerCase();
  const tone = /complete|ready|active|assigned/.test(normalized)
    ? 'success'
    : /fail|error|cancel|inactive/.test(normalized)
      ? 'danger'
      : /warning|pending|scheduled|not_configured/.test(normalized)
        ? 'warning'
        : 'info';
  return (
    <span className={`badge badge-${tone}`}>
      <span aria-hidden>
        {tone === 'success' ? '✓' : tone === 'danger' ? '×' : tone === 'warning' ? '!' : '•'}
      </span>
      {value.replaceAll('_', ' ')}
    </span>
  );
}

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
    <article className={`metric-card metric-card-${tone}`}>
      <span>{label}</span>
      <strong>{value}</strong>
      {detail ? <small>{detail}</small> : null}
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
    <section className="filter-toolbar" aria-label="List filters">
      <div className="filter-bar">{children}</div>
      <div className="filter-toolbar-meta" aria-live="polite">
        <span className="result-count">{resultLabel}</span>
        {onClear ? (
          <button className="clear-filters" onClick={onClear} type="button">
            Clear filters
          </button>
        ) : (
          <span>Showing the latest available data</span>
        )}
      </div>
    </section>
  );
}

export function LoadingState({ label = 'Loading data…' }: { label?: string }) {
  return (
    <div className="panel state-panel loading-state-panel" aria-busy="true" aria-live="polite">
      <BrandLoader label={label} />
      <div className="skeleton-lines" aria-hidden="true">
        <span />
        <span />
      </div>
    </div>
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

  useEffect(() => {
    const timer = window.setTimeout(() => setShowSkeleton(true), 350);
    return () => window.clearTimeout(timer);
  }, []);

  if (!showSkeleton) {
    return (
      <div className="table-loader-intro panel" aria-live="polite">
        <BrandLoader label={label} />
      </div>
    );
  }

  return (
    <div className="table-wrap table-skeleton" aria-busy="true">
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
                  <span
                    className="table-skeleton-line"
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

export function ErrorState({ error, retry }: { error: unknown; retry: () => void }) {
  return (
    <div className="panel state-panel error-state" role="alert">
      <div className="state-icon">!</div>
      <h2>Data could not be loaded</h2>
      <p>{error instanceof Error ? error.message : 'An unexpected error occurred.'}</p>
      <button className="button button-secondary" onClick={retry}>
        Retry
      </button>
    </div>
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
    <div className="panel state-panel">
      <div className="state-icon">◇</div>
      <h2>{title}</h2>
      <p>{description}</p>
      {action}
    </div>
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
    <nav className="pagination" aria-label="Pagination">
      <button disabled={page <= 1} onClick={() => onPage(page - 1)}>
        Previous
      </button>
      <span>
        Page {page} of {totalPages}
      </span>
      <button disabled={page >= totalPages} onClick={() => onPage(page + 1)}>
        Next
      </button>
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
    <div className="table-wrap">
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
