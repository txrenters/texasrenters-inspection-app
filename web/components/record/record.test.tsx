import { fireEvent, render, screen, within } from '@testing-library/react';
import { ClipboardCheckIcon } from 'lucide-react';
import { beforeEach, describe, expect, it } from 'vitest';

import { ConsoleShellProvider } from '@/components/console-shell-context';
import { PageHeader } from '@/components/page-header';

import { FactTable, RecordLayout } from './record-kit';

/**
 * Record pages in the Jobber-style shell (the office, 2026-11-04: "we want the
 * features for familiarity"): headed and laid out as Jobber's job and client
 * pages. Everything invented.
 */

const header = (shell: 'classic' | 'jobber') =>
  render(
    <ConsoleShellProvider shell={shell}>
      <PageHeader
        actions={<button type="button">Assign technician</button>}
        badges={<span>Scheduled</span>}
        description="Entire property · Nov 12, 2026"
        record={{ icon: ClipboardCheckIcon, tone: 'text-chart-3', label: 'Move-out inspection' }}
        title="12 Elm Ct"
      />
    </ConsoleShellProvider>,
  );

describe('the record header', () => {
  it('in the Jobber-style shell, puts the record’s icon and status above its name', () => {
    header('jobber');
    const title = screen.getByRole('heading', { level: 1, name: '12 Elm Ct' });
    const status = screen.getByText('Scheduled');
    expect(screen.getByText('Move-out inspection', { selector: '.sr-only' })).toBeTruthy();
    // The status line comes first, as Jobber's.
    expect(Boolean(status.compareDocumentPosition(title) & Node.DOCUMENT_POSITION_FOLLOWING)).toBe(true);
    expect(screen.getByRole('button', { name: 'Assign technician' })).toBeTruthy();
  });

  it('in the classic console, stays as it was: no record icon', () => {
    header('classic');
    expect(screen.queryByText('Move-out inspection', { selector: '.sr-only' })).toBeNull();
    expect(screen.getByRole('heading', { level: 1, name: '12 Elm Ct' })).toBeTruthy();
  });
});

describe('a title that leads somewhere', () => {
  const titled = (shell: 'classic' | 'jobber', titleHref?: string) =>
    render(
      <ConsoleShellProvider shell={shell}>
        <PageHeader
          record={{ icon: ClipboardCheckIcon, tone: 'text-chart-3', label: 'Move-out inspection' }}
          title="12 Elm Ct"
          titleHref={titleHref}
        />
      </ConsoleShellProvider>,
    );

  it.each(['classic', 'jobber'] as const)('links in the %s layout', (shell) => {
    titled(shell, '/properties/b-1');
    expect(screen.getByRole('link', { name: '12 Elm Ct' }).getAttribute('href')).toBe('/properties/b-1');
    expect(screen.getByRole('heading', { level: 1, name: '12 Elm Ct' })).toBeTruthy();
  });

  it('stays plain words without one', () => {
    titled('jobber');
    expect(screen.queryByRole('link')).toBeNull();
  });
});

describe('the details table', () => {
  it('pairs each label with its value', () => {
    render(<FactTable facts={[{ label: 'Type', value: 'Move-out', detail: 'From Jobber' }]} label="Inspection details" />);
    const table = screen.getByLabelText('Inspection details');
    expect(within(table).getByText('Type').tagName).toBe('DT');
    expect(within(table).getByText('Move-out').closest('dd')).toBeTruthy();
    expect(within(table).getByText('From Jobber')).toBeTruthy();
  });
});

describe('the side panel', () => {
  beforeEach(() => window.localStorage.clear());

  it('can be put away, and is remembered', () => {
    const { unmount } = render(
      <RecordLayout aside={<p>Overview card</p>} asideLabel="About this inspection">
        <p>The record</p>
      </RecordLayout>,
    );
    fireEvent.click(screen.getByRole('button', { name: 'Hide panel' }));
    expect(screen.getByRole('complementary', { name: 'About this inspection' }).className).toContain('xl:hidden');
    expect(screen.getByRole('button', { name: /Show panel/ })).toBeTruthy();
    expect(window.localStorage.getItem('console-record-panel')).toBe('hidden');

    unmount();
    render(
      <RecordLayout aside={<p>Overview card</p>} asideLabel="About this inspection">
        <p>The record</p>
      </RecordLayout>,
    );
    expect(screen.getByRole('complementary', { name: 'About this inspection' }).className).toContain('xl:hidden');
  });

  it('sits beside the record from 2xl when asked, for a page that needs the width', () => {
    render(
      <RecordLayout aside={<p>Overview card</p>} asideLabel="About this inspection" from="2xl">
        <p>The record</p>
      </RecordLayout>,
    );
    expect(screen.getByText('The record').parentElement!.parentElement!.className).toContain('2xl:grid-cols-');
  });
});
