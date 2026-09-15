import type { AdminInspection } from '@texasrenters/shared';
import { render, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';

import { InspectionEditDialog } from './inspection-actions-dialogs';

/**
 * A Jobber visit's date is Jobber's.
 *
 * The sync puts Jobber's date back on its next pass, so the form used to accept
 * a date that quietly reverted two minutes later: 10118 Mariposa Green Ct's
 * move-in, re-dated to the report it held and restored to the next tenant's
 * visit. The API refuses that now, and the form says where to go instead of
 * offering it.
 */

vi.mock('@/lib/queries', () => ({
  useAdminMutations: () => ({
    updateInspection: { mutateAsync: vi.fn(), isPending: false, error: null },
  }),
}));

const inspection = (overrides: Partial<AdminInspection> = {}): AdminInspection => ({
  id: 'inspection-1',
  status: 'SCHEDULED',
  inspectionType: 'MOVE_IN',
  priority: 'STANDARD',
  scheduledAt: '2026-10-02T00:00:00.000Z',
  createdAt: '2026-09-01T21:43:19.000Z',
  updatedAt: '2026-09-14T18:45:58.000Z',
  internalNotes: null,
  assignments: [],
  ...overrides,
});

describe('the scheduled date in the edit form', () => {
  it('is locked on a Jobber visit, with where to change it', () => {
    render(<InspectionEditDialog inspection={inspection({ scheduledInJobber: true })} onClose={() => {}} />);

    expect((screen.getByLabelText('Scheduled date') as HTMLButtonElement).disabled).toBe(true);
    expect(screen.getByText(/scheduled in jobber\. change the date there/i)).toBeTruthy();
  });

  it('opens on a Jobber visit when the console sends its changes to Jobber', () => {
    render(
      <InspectionEditDialog
        inspection={inspection({ scheduledInJobber: true, jobberEditsPushed: true })}
        onClose={() => {}}
      />,
    );

    expect((screen.getByLabelText('Scheduled date') as HTMLButtonElement).disabled).toBe(false);
    expect(screen.getByText(/moves the jobber visit to it too/i)).toBeTruthy();
  });

  it('stays editable on an inspection scheduled here', () => {
    render(<InspectionEditDialog inspection={inspection({ scheduledInJobber: false })} onClose={() => {}} />);

    expect((screen.getByLabelText('Scheduled date') as HTMLButtonElement).disabled).toBe(false);
    expect(screen.getByText(/controls when this inspection appears/i)).toBeTruthy();
  });
});
