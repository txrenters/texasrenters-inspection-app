import type { PropertyServiceView } from '@texasrenters/shared';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { PropertyServiceCard } from './property-service-card';

/**
 * The office's switches on a property (2026-10-08): Propertyware is told late
 * when an owner ends the management or a property leaves the benefit package,
 * and the lease schedule went on booking move-outs and move-ins there. People
 * and places invented.
 */

const NOTHING_ON: PropertyServiceView = {
  status: { managementEnded: null, tbpOptedOut: null },
  stillBooked: [],
  leaseScheduleOn: true,
};

const state = vi.hoisted(() => ({
  view: null as PropertyServiceView | null,
  mutateAsync: vi.fn(),
  allowed: true,
}));
vi.mock('@/lib/property-service-queries', () => ({
  usePropertyServiceStatus: () => ({ data: state.view, isError: false, error: null, refetch: vi.fn() }),
  useSetPropertyServiceStatus: () => ({ mutateAsync: state.mutateAsync, isPending: false, error: null, reset: vi.fn() }),
}));
vi.mock('@/lib/auth', () => ({ usePermissions: () => ({ has: () => state.allowed }) }));

const mount = () => render(<PropertyServiceCard propertyId="prop-1" propertyName="12 Example Ln" />);
const managementSwitch = () => screen.getByRole('switch', { name: /Owner ended the management/ });
const packageSwitch = () => screen.getByRole('switch', { name: /Opted out of the benefit package/ });

beforeEach(() => {
  vi.clearAllMocks();
  state.view = NOTHING_ON;
  state.allowed = true;
  state.mutateAsync.mockResolvedValue({ ...NOTHING_ON, calledOff: 2, booked: 0 });
});

describe('the owner ended the management', () => {
  it('asks first, saying what will be cancelled, and sends nothing until confirmed', async () => {
    mount();
    fireEvent.click(managementSwitch());

    expect(screen.getByText('Has the owner ended the management?')).toBeInTheDocument();
    expect(screen.getByText(/cancelled now — in Jobber too — and their technician is told/)).toBeInTheDocument();
    expect(state.mutateAsync).not.toHaveBeenCalled();

    fireEvent.click(screen.getByRole('button', { name: 'Switch on' }));

    expect(state.mutateAsync).toHaveBeenCalledWith({ managementEnded: true });
    await waitFor(() => expect(screen.getByText('Switched on. Called off 2 move-outs and move-ins.')).toBeInTheDocument());
  });

  it('changes nothing when the office keeps it as it is', () => {
    mount();
    fireEvent.click(managementSwitch());
    fireEvent.click(screen.getByRole('button', { name: 'Keep as it is' }));

    expect(state.mutateAsync).not.toHaveBeenCalled();
    expect(managementSwitch()).not.toBeChecked();
  });

  it('says plainly that nothing booked earlier is called off while the lease schedule is switched off', () => {
    state.view = { ...NOTHING_ON, leaseScheduleOn: false };
    mount();
    fireEvent.click(managementSwitch());

    expect(screen.getByText(/anything it booked earlier stays until someone cancels it/)).toBeInTheDocument();
  });

  it('says who switched it on, and lists what is still booked there for a person to cancel', () => {
    state.view = {
      status: { managementEnded: { at: '2026-10-07T15:00:00Z', by: { id: 'u-1', displayName: 'Pat Office' } }, tbpOptedOut: null },
      stillBooked: [
        { inspectionId: 'insp-1', inspectionType: 'MOVE_OUT', status: 'SCHEDULED', scheduledOn: '2026-10-23', technician: 'Sam Tech' },
      ],
      leaseScheduleOn: true,
    };
    mount();

    expect(managementSwitch()).toBeChecked();
    expect(screen.getByText(/Switched on by Pat Office/)).toBeInTheDocument();
    expect(screen.getByText('One visit is still booked here')).toBeInTheDocument();
    expect(screen.getByRole('link', { name: /Move-out/ })).toHaveAttribute('href', '/inspections/insp-1');
    expect(screen.getByText(/Sam Tech/)).toBeInTheDocument();
  });
});

describe('the property opted out of the benefit package', () => {
  it('says the move-ins and move-outs go on', async () => {
    state.mutateAsync.mockResolvedValue({ ...NOTHING_ON, calledOff: 0, booked: 0 });
    mount();
    fireEvent.click(packageSwitch());

    expect(screen.getByText('Move-ins and move-outs are not affected.')).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Switch on' }));

    expect(state.mutateAsync).toHaveBeenCalledWith({ tbpOptedOut: true });
    await waitFor(() => expect(screen.getByText('Switched on.')).toBeInTheDocument());
  });
});

it('lets only someone who manages properties turn them', () => {
  state.allowed = false;
  mount();

  expect(managementSwitch()).toBeDisabled();
  expect(packageSwitch()).toBeDisabled();
});
