import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { InspectionBulkBar, type BulkRow } from './inspection-bulk-bar';

/**
 * The bar for picked inspections (console-development, T09). Every action is
 * what one row can already do, applied to each picked row in turn; nothing
 * here books in Jobber. Mocked calls only: nothing is sent anywhere.
 */

const calls = vi.hoisted(() => ({
  assign: vi.fn(),
  reassign: vi.fn(),
  updateInspection: vi.fn(),
}));

vi.mock('@/lib/queries', () => ({
  useAdminMutations: () => ({
    assign: { mutateAsync: calls.assign },
    reassign: { mutateAsync: calls.reassign },
    updateInspection: { mutateAsync: calls.updateInspection },
  }),
}));
vi.mock('sonner', () => ({ toast: { success: vi.fn(), error: vi.fn() } }));
// The date field is a popover calendar; a plain input stands in for it here.
vi.mock('@/components/ui/date-picker', () => ({
  DatePicker: ({ id, value, onChange }: { id: string; value: string; onChange: (value: string) => void }) => (
    <input id={id} onChange={(event) => onChange(event.target.value)} value={value} />
  ),
}));

// The technician dropdown is a Radix popover; buttons stand in for its items here.
vi.mock('@/components/ui/select', async () => {
  const React = await import('react');
  const Pick = React.createContext<(value: string) => void>(() => {});
  return {
    Select: ({ onValueChange, children }: { onValueChange: (value: string) => void; children: React.ReactNode }) => (
      <Pick.Provider value={onValueChange}>{children}</Pick.Provider>
    ),
    SelectTrigger: ({ id }: { id: string }) => <span id={id} />,
    SelectValue: () => null,
    SelectContent: ({ children }: { children: React.ReactNode }) => <div>{children}</div>,
    SelectItem: ({ value, children }: { value: string; children: React.ReactNode }) => {
      const pick = React.useContext(Pick);
      return (
        <button onClick={() => pick(value)} type="button">
          {children}
        </button>
      );
    },
  };
});

const ROWS: BulkRow[] = [
  { id: 'i-1', name: '1204 Cedar Hollow Dr', upcoming: true, technicianId: null },
  { id: 'i-2', name: '88 Lantern Bay Ct', upcoming: true, technicianId: 't-2' },
  { id: 'i-3', name: '1350 Pecan Bluff', upcoming: false, technicianId: 't-3' },
];

function bar(props: Partial<Parameters<typeof InspectionBulkBar>[0]> = {}) {
  const onClear = vi.fn();
  const onDelete = vi.fn();
  render(
    <InspectionBulkBar
      canAssign
      canDelete={false}
      canManage
      onClear={onClear}
      onDelete={onDelete}
      rows={ROWS}
      technicians={[
        { value: 't-1', label: 'Moses R.' },
        { value: 't-2', label: 'Amy W.' },
      ]}
      {...props}
    />,
  );
  return { onClear, onDelete };
}

beforeEach(() => {
  calls.assign.mockReset().mockResolvedValue({});
  calls.reassign.mockReset().mockResolvedValue({});
  calls.updateInspection.mockReset().mockResolvedValue({});
});

describe('the bar for picked inspections', () => {
  it('offers only what the person may do, and never a Jobber booking', () => {
    bar({ canAssign: false, canDelete: true });

    expect(screen.getByRole('toolbar', { name: 'Selected inspections' })).toHaveTextContent('3 selected');
    expect(screen.queryByRole('button', { name: 'Assign' })).toBeNull();
    expect(screen.getByRole('button', { name: 'Reschedule' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /Delete/ })).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /Book/ })).toBeNull();
  });

  it('cancels each upcoming visit with the reason, leaving the done one out', async () => {
    const { onClear } = bar();

    fireEvent.click(screen.getByRole('button', { name: 'Cancel' }));
    expect(screen.getByRole('dialog')).toHaveTextContent('2 inspections; 1 done or cancelled is left out');
    const confirm = screen.getByRole('button', { name: 'Cancel 2' });
    expect(confirm).toBeDisabled();

    fireEvent.change(screen.getByLabelText('Cancellation reason'), { target: { value: 'Tenant asked' } });
    fireEvent.click(confirm);

    await waitFor(() => expect(onClear).toHaveBeenCalled());
    expect(calls.updateInspection.mock.calls.map(([input]) => input)).toEqual([
      { id: 'i-1', status: 'CANCELLED', cancellationReason: 'Tenant asked' },
      { id: 'i-2', status: 'CANCELLED', cancellationReason: 'Tenant asked' },
    ]);
  });

  it('moves the upcoming visits to the day picked, sent as that date', async () => {
    bar();

    fireEvent.click(screen.getByRole('button', { name: 'Reschedule' }));
    fireEvent.change(screen.getByLabelText('New day (Texas)'), { target: { value: '2026-10-14' } });
    fireEvent.click(screen.getByRole('button', { name: 'Move 2' }));

    await waitFor(() => expect(calls.updateInspection).toHaveBeenCalledTimes(2));
    expect(calls.updateInspection.mock.calls[0][0]).toEqual({
      id: 'i-1',
      scheduledAt: '2026-10-14T00:00:00.000Z',
    });
  });

  it('lists the ones the server refused, by name and in its words, and keeps the rest', async () => {
    calls.updateInspection
      .mockResolvedValueOnce({})
      .mockRejectedValueOnce(new Error('This visit is in Jobber. Change it there.'));
    const { onClear } = bar();

    fireEvent.click(screen.getByRole('button', { name: 'Reschedule' }));
    fireEvent.change(screen.getByLabelText('New day (Texas)'), { target: { value: '2026-10-14' } });
    fireEvent.click(screen.getByRole('button', { name: 'Move 2' }));

    expect(await screen.findByText('1 was not changed:')).toBeInTheDocument();
    expect(screen.getByText('88 Lantern Bay Ct: This visit is in Jobber. Change it there.')).toBeInTheDocument();
    expect(onClear).not.toHaveBeenCalled();
  });

  it('assigns the unassigned, reassigns the others, and leaves alone those already on that person', async () => {
    bar();

    fireEvent.click(screen.getByRole('button', { name: 'Assign' }));
    fireEvent.click(screen.getByRole('button', { name: 'Moses R.' }));
    fireEvent.click(screen.getByRole('button', { name: 'Assign 2' }));
    await waitFor(() => expect(calls.reassign).toHaveBeenCalled());
    expect(calls.assign).toHaveBeenCalledWith({ id: 'i-1', technicianId: 't-1', reason: undefined });
    expect(calls.reassign).toHaveBeenCalledWith({ id: 'i-2', technicianId: 't-1', reason: undefined });
  });

  it('skips a visit already on the chosen technician', async () => {
    bar();

    fireEvent.click(screen.getByRole('button', { name: 'Assign' }));
    fireEvent.click(screen.getByRole('button', { name: 'Amy W.' }));
    fireEvent.click(screen.getByRole('button', { name: 'Assign 2' }));
    await waitFor(() => expect(calls.assign).toHaveBeenCalledTimes(1));
    expect(calls.reassign).not.toHaveBeenCalled();
  });
});
