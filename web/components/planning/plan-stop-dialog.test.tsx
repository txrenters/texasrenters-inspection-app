import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { PlanStopDialog } from './plan-stop-dialog';

const hooks = vi.hoisted(() => ({
  usePlanTechnicians: vi.fn(),
  usePlanningMutations: vi.fn(),
}));
vi.mock('@/lib/planning-queries', () => hooks);

const editStop = { mutateAsync: vi.fn() };

const DETAILS = 'Filter Change: 20x25x1 + Pest Control + Occupied Inspection\n\nInstruction for completion';

const stop = (overrides: Record<string, unknown> = {}) =>
  ({
    id: 's1',
    sequence: 12,
    previousSequence: 11,
    orderSource: 'PRIOR_QUARTER',
    zone: '1',
    scheduledOn: '2026-10-06T00:00:00.000Z',
    positionInDay: 1,
    assignedTechnicianId: 'moses',
    assignedTechnician: { id: 'moses', displayName: 'Moses Rodriguez' },
    unitResolution: 'NO_UNITS',
    status: 'PLANNED',
    blockedCode: null,
    blockedMessage: null,
    inspectionType: 'OCCUPIED',
    inspectionTypeReason: 'HVAC_PLAN_NOT_ADDED',
    inspectionTypeNeedsReview: false,
    inspectionTypeOverriddenAt: null,
    onSiteMinutes: 30,
    driveSecondsForecast: null,
    officeDetails: null,
    visitTitle: '1 Any St - Zone 1 - Q4 2026 Tenant Benefit Package',
    visitDetails: DETAILS,
    inspectionId: null,
    jobberVisitId: null,
    hvacFilterSizes: ['20x25x1'],
    scheduleOverriddenAt: null,
    technicianOverriddenAt: null,
    visitTitleOverriddenAt: null,
    visitDetailsOverriddenAt: null,
    onSiteMinutesOverriddenAt: null,
    unitOverriddenAt: null,
    previousTechnician: null,
    propertywareUnit: null,
    buildingUnits: [],
    tenant: {
      leaseName: 'Tenant of 1 Any St',
      addressLine1: '1 Any St',
      city: 'Houston',
      state: 'TX',
      postalCode: '77009',
      managementPlan: 'Basic',
      hvacPlan: 'Not Completed',
      startDate: null,
      endDate: null,
      hvacFilterLocation: null,
      hvacFilterSizes: ['20x25x1'],
      lastFilterDelivery: null,
      lastHvacInspection: null,
      lastOccupiedInspection: null,
    },
    ...overrides,
  }) as never;

const mount = (props: Record<string, unknown> = {}) =>
  render(
    <PlanStopDialog
      closedDays={['2026-10-12']}
      day={null}
      editable
      onOpenChange={() => {}}
      quarter={{ year: 2026, quarter: 4 }}
      stop={stop()}
      {...props}
    />,
  );

beforeEach(() => {
  editStop.mutateAsync.mockReset().mockResolvedValue({ id: 's1', changed: [] });
  hooks.usePlanningMutations.mockReturnValue({ editStop });
  hooks.usePlanTechnicians.mockReturnValue({
    data: [
      { id: 'moses', displayName: 'Moses Rodriguez', crewOrder: 1, hasHome: true },
      { id: 'kevin', displayName: 'Kevin Granados', crewOrder: 2, hasHome: true },
      { id: 'amy', displayName: 'Amy Wilson', crewOrder: null, hasHome: false },
    ],
  });
});

describe('changing a draft visit in its window', () => {
  it('opens the Details for editing when they are clicked, and saves them on leaving the field', async () => {
    mount();

    fireEvent.click(screen.getByRole('button', { name: /Change the Details/ }));
    const field = screen.getByRole('textbox', { name: 'Details' });
    fireEvent.change(field, { target: { value: `${DETAILS}\nGate code is at the office` } });
    fireEvent.blur(field);

    await waitFor(() =>
      expect(editStop.mutateAsync).toHaveBeenCalledWith({ stopId: 's1', visitDetails: `${DETAILS}\nGate code is at the office` }),
    );
    await waitFor(() => expect(screen.queryByRole('textbox', { name: 'Details' })).toBeNull());
  });

  it('keeps what was typed, and says why, when a change is refused', async () => {
    editStop.mutateAsync.mockRejectedValueOnce(new Error('Keep “Tenant Benefit Package” in the title.'));
    mount();

    fireEvent.click(screen.getByRole('button', { name: /Change the title/ }));
    const field = screen.getByRole('textbox', { name: 'title' });
    fireEvent.change(field, { target: { value: '1 Any St - Zone 1' } });
    fireEvent.keyDown(field, { key: 'Enter' });

    expect(await screen.findByRole('alert')).toHaveTextContent('Keep “Tenant Benefit Package” in the title.');
    expect((screen.getByRole('textbox', { name: 'title' }) as HTMLInputElement).value).toBe('1 Any St - Zone 1');
  });

  it('puts a value back on Escape, without saving or closing the window', () => {
    const onOpenChange = vi.fn();
    mount({ onOpenChange });

    fireEvent.click(screen.getByRole('button', { name: /Change the time on site/ }));
    const field = screen.getByRole('textbox', { name: 'time on site' });
    fireEvent.change(field, { target: { value: '90' } });
    fireEvent.keyDown(field, { key: 'Escape' });

    expect(editStop.mutateAsync).not.toHaveBeenCalled();
    expect(onOpenChange).not.toHaveBeenCalled();
    expect(screen.getByRole('button', { name: /Change the time on site/ })).toHaveTextContent('30 min');
  });

  it('takes the time on site in whole minutes, and asks again for anything else', async () => {
    mount();

    fireEvent.click(screen.getByRole('button', { name: /Change the time on site/ }));
    const field = screen.getByRole('textbox', { name: 'time on site' });
    fireEvent.change(field, { target: { value: 'an hour' } });
    fireEvent.keyDown(field, { key: 'Enter' });
    expect(await screen.findByRole('alert')).toHaveTextContent('Write the time on site in whole minutes, like 45.');
    expect(editStop.mutateAsync).not.toHaveBeenCalled();

    fireEvent.change(screen.getByRole('textbox', { name: 'time on site' }), { target: { value: '60' } });
    fireEvent.keyDown(screen.getByRole('textbox', { name: 'time on site' }), { key: 'Enter' });
    await waitFor(() => expect(editStop.mutateAsync).toHaveBeenCalledWith({ stopId: 's1', onSiteMinutes: 60 }));
  });

  it('gives the visit to another technician from the list, the crew first', async () => {
    mount();

    fireEvent.click(screen.getByRole('button', { name: /Change the technician/ }));
    expect(await screen.findByText('Benefit-package crew')).toBeTruthy();
    expect(screen.getByText('Other technicians')).toBeTruthy();
    fireEvent.click(screen.getByRole('option', { name: /Amy Wilson/ }));

    await waitFor(() => expect(editStop.mutateAsync).toHaveBeenCalledWith({ stopId: 's1', assignedTechnicianId: 'amy' }));
  });

  it('moves the visit to another day of the quarter, and names a day kept for rescheduled visits', async () => {
    mount({ stop: stop({ scheduledOn: '2026-10-05T00:00:00.000Z' }) });

    expect(screen.getByText('A Monday kept for rescheduled visits.')).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: /Change the date/ }));
    fireEvent.click(await screen.findByRole('button', { name: /October 8th, 2026/ }));

    await waitFor(() => expect(editStop.mutateAsync).toHaveBeenCalledWith({ stopId: 's1', scheduledOn: '2026-10-08' }));
  });

  /** 5009 N Main St: the reports hold the building, so which unit a tenancy is behind is a person's to say. */
  it('asks which unit a tenancy in a building of several is in', async () => {
    mount({
      stop: stop({
        status: 'BLOCKED',
        blockedCode: 'UNIT_REQUIRED',
        blockedMessage: 'This building has several units, and Propertyware does not say which this tenancy is in. Open the visit and choose its unit.',
        unitResolution: 'UNRESOLVED',
        buildingUnits: [
          { id: 'unit-half', name: '1/2', addressLine1: '5009 1/2 N Main St' },
          { id: 'unit-house', name: 'House', addressLine1: '5009 N Main St' },
        ],
      }),
    });

    const unit = screen.getByRole('button', { name: /Change the unit/ });
    expect(unit).toHaveTextContent('Choose which unit this tenancy is in');
    fireEvent.click(unit);
    fireEvent.click(await screen.findByRole('option', { name: /5009 1\/2 N Main St/ }));

    await waitFor(() => expect(editStop.mutateAsync).toHaveBeenCalledWith({ stopId: 's1', propertywareUnitId: 'unit-half' }));
  });

  it('changes the kind of visit from its value', async () => {
    mount();

    fireEvent.click(screen.getByRole('button', { name: /Change the kind of visit/ }));
    fireEvent.click(await screen.findByRole('option', { name: /HVAC inspection/ }));

    await waitFor(() => expect(editStop.mutateAsync).toHaveBeenCalledWith({ stopId: 's1', inspectionType: 'HVAC' }));
  });

  it('shows plain values, with nothing to click, for a visit that can no longer change', () => {
    mount({ stop: stop({ status: 'PUBLISHED', inspectionId: 'insp-1' }) });
    expect(screen.queryByRole('button', { name: /^Change / })).toBeNull();
    expect(hooks.usePlanTechnicians).toHaveBeenLastCalledWith(false);
    expect(screen.getByText('1 Any St - Zone 1 - Q4 2026 Tenant Benefit Package')).toBeTruthy();
  });

  it('shows plain values to someone who cannot change the plan', () => {
    mount({ editable: false });
    expect(screen.queryByRole('button', { name: /^Change / })).toBeNull();
  });
});
