import type { AdminInspectionComparison } from '@texasrenters/shared';
import { render, screen } from '@testing-library/react';
import type { ReactNode } from 'react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import ComparisonReportPage from './page';

/**
 * The console's preview of the comparison report (the office, 2026-10-07): it
 * used to say "Not ready to share" until every room was decided and the whole
 * approved. Nothing stands in the way now; what has not reached it is said.
 */

const state = vi.hoisted(() => ({
  comparison: null as Partial<AdminInspectionComparison> | null,
}));

vi.mock('next/navigation', () => ({ useParams: () => ({ inspectionId: 'move-out-1' }) }));
vi.mock('@/lib/auth', () => ({ usePermissions: () => ({ has: () => true }) }));
vi.mock('@/lib/queries', () => ({
  useComparisonReport: () => ({ data: {}, isLoading: false, error: null, refetch: vi.fn() }),
  useInspectionComparison: () => ({ data: state.comparison }),
}));
vi.mock('@texasrenters/shared', async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  buildComparisonView: () => ({}),
}));
// The document itself has tests of its own; here only what is above it.
vi.mock('@/components/comparison-document', () => ({
  ComparisonDocument: ({ banner }: { banner: ReactNode }) => <div>{banner}</div>,
}));

beforeEach(() => {
  state.comparison = { id: 'comparison-1', recordingsProcessing: 0, findingsToConfirm: 0, areas: [] };
});

describe('the comparison report preview', () => {
  it('can be shared as soon as there is a comparison', () => {
    render(<ComparisonReportPage />);

    expect(screen.getByRole('button', { name: /Share with owner or tenant/ })).toBeEnabled();
    expect(screen.queryByText('Not ready to share')).toBeNull();
    expect(screen.queryByText('Still to come')).toBeNull();
  });

  it('says what has not reached it yet, and still lets it go', () => {
    state.comparison = { ...state.comparison, findingsToConfirm: 3 };
    render(<ComparisonReportPage />);

    expect(screen.getByText('Still to come')).toBeInTheDocument();
    expect(screen.getByText(/3 findings are waiting to be confirmed/)).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /Share with owner or tenant/ })).toBeEnabled();
  });

  it('has nothing to share before there is a comparison', () => {
    state.comparison = null;
    render(<ComparisonReportPage />);

    expect(screen.getByRole('button', { name: /Share with owner or tenant/ })).toBeDisabled();
  });
});
