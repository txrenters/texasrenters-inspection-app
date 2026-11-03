import { render, screen, within } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { ConsoleShellProvider } from '@/components/console-shell-context';
import { ListSummary } from '@/components/list-summary';
import { ListToolbar, SelectFilter } from '@/components/list-toolbar';
import { PageSearchProvider, usePageSearch } from '@/components/page-search';
import { PropertiesSummary } from '@/components/summaries/directory-summaries';
import { InspectionsSummary } from '@/components/summaries/inspections-summary';
import { businessToday, shiftDay } from '@/lib/clock';

/**
 * The lists in the Jobber-style shell (the office, 2026-11-04: "we want the
 * features for familiarity"): laid out as Jobber's -- a heading with the
 * count, pill filters, the search inside the list -- and Jobber's strip above.
 * The classic layout must not move.
 */

const asked = vi.hoisted(() => ({ inspections: [] as Record<string, unknown>[], properties: [] as Record<string, unknown>[] }));
vi.mock('@/lib/queries', () => ({
  useInspections: (query: Record<string, unknown>) => {
    asked.inspections.push(query);
    return { data: { total: query.status === 'DONE' && String(query.scheduledFrom).startsWith(shiftDay(businessToday(), -60)) ? 10 : 13 } };
  },
  useProperties: (query: Record<string, unknown>) => {
    asked.properties.push(query);
    return { data: { total: 4 } };
  },
  useTenants: () => ({ data: { total: 2 } }),
}));
vi.mock('@/lib/reschedule-queries', () => ({ useRescheduleRequests: () => ({ data: undefined }) }));

/** What the top bar would show: the search a list lends it, if any. */
function LentSearch() {
  const search = usePageSearch();
  return <p data-testid="lent">{search ? search.label : 'nothing lent'}</p>;
}

function toolbar(shell: 'classic' | 'jobber') {
  return render(
    <ConsoleShellProvider shell={shell}>
      <PageSearchProvider>
        <ListToolbar
          heading="All inspections"
          onSearch={() => {}}
          resultLabel="13 inspections"
          search=""
          searchLabel="Search inspections"
        />
        <LentSearch />
      </PageSearchProvider>
    </ConsoleShellProvider>,
  );
}

beforeEach(() => {
  asked.inspections = [];
  asked.properties = [];
});

describe('the list toolbar', () => {
  it('in the classic console, lends its search to the header and shows no heading', () => {
    toolbar('classic');
    expect(screen.getByTestId('lent').textContent).toBe('Search inspections');
    expect(screen.queryByRole('heading', { name: 'All inspections' })).toBeNull();
    expect(screen.getByText('13 inspections')).toBeTruthy();
  });

  it('in the Jobber-style shell, heads the list with its count and keeps its own search', () => {
    toolbar('jobber');
    expect(screen.getByRole('heading', { name: 'All inspections' })).toBeTruthy();
    expect(screen.getByText('(13 inspections)')).toBeTruthy();
    // The top bar's search stays the search for everything.
    expect(screen.getByTestId('lent').textContent).toBe('nothing lent');
    const field = screen.getByRole('searchbox', { name: 'Search inspections' });
    expect(field.parentElement!.className).not.toContain('sm:hidden');
  });
});

describe('the filter pill', () => {
  const pill = (value: string) =>
    render(
      <ConsoleShellProvider shell="jobber">
        <SelectFilter
          label="Status"
          onChange={() => {}}
          options={[
            { value: 'DONE', label: 'Done' },
            { value: 'SCHEDULED', label: 'Scheduled' },
          ]}
          value={value}
        />
      </ConsoleShellProvider>,
    );

  it('reads "Status | All" until it narrows the list', () => {
    pill('');
    const trigger = screen.getByRole('combobox', { name: 'Status' });
    expect(within(trigger).getByText('Status')).toBeTruthy();
    expect(within(trigger).getByText('All')).toBeTruthy();
    expect(trigger.className).toContain('rounded-full');
    expect(trigger.className).not.toContain('bg-accent');
  });

  it('names the choice and fills in once it does', () => {
    pill('DONE');
    const trigger = screen.getByRole('combobox', { name: 'Status' });
    expect(within(trigger).getByText('Done')).toBeTruthy();
    expect(trigger.className).toContain('bg-accent');
  });
});

describe('the summary strip', () => {
  it('shows an overview with links, and a figure with how it moved', () => {
    render(
      <ListSummary
        label="Test strip"
        metrics={[
          { title: 'Visits done', caption: 'Past 30 days', value: 13, trend: { percent: 30, direction: 'up' }, moreIsBetter: true },
          { title: 'Problems', caption: 'Past 30 days', value: 3, trend: { percent: 50, direction: 'up' }, moreIsBetter: false },
        ]}
        overview={[{ label: 'In progress', value: 2, dot: 'bg-info', href: '/inspections?status=IN_PROGRESS' }]}
      />,
    );
    expect(screen.getByRole('link', { name: /In progress/ }).getAttribute('href')).toBe('/inspections?status=IN_PROGRESS');
    // A rise is green where more is better, red where it is not.
    expect(screen.getByText('30%').className).toContain('text-success');
    expect(screen.getByText('50%').className).toContain('text-destructive');
  });
});

describe('the Inspections strip', () => {
  it('counts the type being looked at, over whole Texas days sent as UTC midnights', () => {
    render(<InspectionsSummary type="MOVE_OUT" />);
    const today = businessToday();

    expect(asked.inspections).toHaveLength(7);
    expect(asked.inspections.every((query) => query.inspectionType === 'MOVE_OUT' && query.pageSize === 1)).toBe(true);
    expect(asked.inspections).toContainEqual(
      expect.objectContaining({
        status: 'DONE',
        scheduledFrom: `${shiftDay(today, -30)}T00:00:00.000Z`,
        scheduledTo: `${shiftDay(today, -1)}T00:00:00.000Z`,
      }),
    );
    // 13 done in the past 30 days against 10 in the 30 before.
    expect(screen.getByText('30%')).toBeTruthy();
    expect(screen.getByRole('link', { name: /Need a technician/ }).getAttribute('href')).toBe(
      '/inspections?tech=unassigned&day=all&type=MOVE_OUT',
    );
  });
});

describe('the Properties strip', () => {
  /** Its counts are the tabs' own when no search is in force, so they are read once for both. */
  it('asks for the tabs’ counts with the tabs’ own keys', () => {
    render(<PropertiesSummary />);
    expect(asked.properties).toContainEqual({ search: '', portfolioId: '', active: true, pageSize: 1, occupancy: 'OCCUPIED' });
    expect(asked.properties).toContainEqual({ search: '', portfolioId: '', active: true, pageSize: 1 });
  });
});

describe('a strip whose figures could not be read', () => {
  it('shows a dash, not a figure loading for ever', () => {
    render(
      <ListSummary
        label="Failed strip"
        metrics={[{ title: 'Active tenants', caption: 'From the report', value: null }]}
        overview={[{ label: 'Enrolled', value: null, dot: 'bg-success' }, { label: 'Not enrolled', value: undefined, dot: 'bg-muted-foreground' }]}
      />,
    );
    expect(screen.getByText('(—)')).toBeTruthy();
    expect(screen.getByText('(…)')).toBeTruthy();
    expect(screen.getByText('—')).toBeTruthy();
  });
});
