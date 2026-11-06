import type { AdminInspection } from '@texasrenters/shared';
import { fireEvent, render, screen, within } from '@testing-library/react';
import { ClipboardCheckIcon } from 'lucide-react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { ConsoleShellProvider } from '@/components/console-shell-context';
import { PageHeader } from '@/components/page-header';

import { InspectionRecordAside, InspectionRecordTop } from './inspection-record';
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

const inspection = (over: Partial<AdminInspection> = {}) =>
  ({
    id: 'insp-1',
    status: 'SCHEDULED',
    inspectionType: 'MOVE_OUT',
    priority: 'STANDARD',
    scheduledAt: '2026-11-12T00:00:00.000Z',
    propertywareBuilding: { id: 'b-1', name: '12 Elm Ct', addressLine1: '12 Elm Ct', city: 'Testville', state: 'TX' },
    propertywareUnit: null,
    internalNotes: null,
    jobberVisitTitle: '12 Elm Ct - Zone 2 - Move out',
    ...over,
  }) as AdminInspection;

describe('the inspection’s card and details', () => {
  it('shows the place and where the review stands, leaving who and when to the header and the Visit card', () => {
    render(
      <InspectionRecordTop
        figures={{ areasReviewed: '2 of 6', findingsToReview: 3, comparedWith: { id: 'insp-in', scheduledAt: '2025-06-01T00:00:00.000Z' }, comparesToMoveIn: true }}
        item={inspection()}
      />,
    );
    expect(screen.getByRole('link', { name: '12 Elm Ct' }).getAttribute('href')).toBe('/properties/b-1');
    const details = screen.getByLabelText('Inspection details');
    expect(within(details).queryByText('Type')).toBeNull();
    expect(within(details).queryByText('Scheduled')).toBeNull();
    expect(within(details).getByText('2 of 6')).toBeTruthy();
    expect(within(details).getByText('3').className).toContain('text-warning');
    expect(within(details).getByRole('link', { name: /Move-in/ }).getAttribute('href')).toBe('/inspections/insp-in');
  });

  it('leaves out the findings row for an account that may not read findings', () => {
    render(
      <InspectionRecordTop
        figures={{ areasReviewed: null, findingsToReview: null, comparesToMoveIn: false }}
        item={inspection({ inspectionType: 'HVAC' })}
      />,
    );
    expect(screen.queryByText('Findings to review')).toBeNull();
    expect(screen.queryByText('Compared with')).toBeNull();
  });
});

describe('the inspection’s side panel', () => {
  it('shows the notes, the last five things that happened, and the way to the rest', () => {
    const onSeeActivity = vi.fn();
    render(
      <InspectionRecordAside
        activity={Array.from({ length: 7 }, (_, index) => ({
          id: `e-${index}`,
          action: 'FINDING_APPROVED',
          actorName: 'Ada Lane',
          createdAt: '2026-11-03T15:00:00.000Z',
        }))}
        item={inspection({ internalNotes: 'Gate code at the office.' })}
        onSeeActivity={onSeeActivity}
        technicianName="Ada Lane"
      />,
    );
    expect(screen.getByText('Gate code at the office.')).toBeTruthy();
    expect(screen.getAllByText('Finding approved')).toHaveLength(5);
    fireEvent.click(screen.getByRole('button', { name: 'See all' }));
    expect(onSeeActivity).toHaveBeenCalledTimes(1);
  });

  it('says plainly when there are no notes', () => {
    render(<InspectionRecordAside activity={[]} item={inspection()} onSeeActivity={() => {}} technicianName={null} />);
    expect(screen.getByText('No internal notes yet.')).toBeTruthy();
    expect(screen.getByText('Nothing recorded yet.')).toBeTruthy();
  });

  it("leaves Jobber's job number to the header, where it is said once", () => {
    render(
      <InspectionRecordAside activity={[]} item={inspection({ jobberJobNumber: '20625' })} onSeeActivity={() => {}} technicianName={null} />,
    );
    expect(screen.queryByText('Job #')).toBeNull();
  });
});
