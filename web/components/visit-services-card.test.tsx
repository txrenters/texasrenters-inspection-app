import { parseVisitDetails, type BookingPrefill } from '@texasrenters/shared';
import { fireEvent, render, screen, within } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';

import { bookingForm, type BookingFormState } from '@/lib/jobber-booking';

import { VisitServicesCard } from './visit-services-card';

/**
 * Pest control and the AC filter change on a visit created in the console, of
 * any kind (the office, 2026-09-19). Addresses and sizes invented.
 */

const prefill: BookingPrefill = {
  zone: 'Zone 3',
  benefitPackage: false,
  planTier: null,
  hvacOptedOut: false,
  filters: [{ size: '20x25x1', media: false, location: 'Hallway' }],
  tenants: [],
};

const ticked = (overrides: Partial<BookingFormState['services']> = {}): BookingFormState => {
  const form = bookingForm(prefill, 'HVAC');
  return { ...form, services: { ...form.services, filterChange: true, pestControl: true, ...overrides } };
};

const card = (props: Partial<Parameters<typeof VisitServicesCard>[0]> = {}) => (
  <VisitServicesCard booked form={ticked()} inspectionType="HVAC" onChange={vi.fn()} {...props} />
);

describe('the services on the create form', () => {
  it('offers the filter change, pest control and a flea treatment on an HVAC visit, with its inspection always', () => {
    render(card());

    const services = screen.getByRole('group', { name: 'Services' });
    expect(within(services).getByRole('checkbox', { name: 'AC filter change' })).toBeChecked();
    expect(within(services).getByRole('checkbox', { name: 'Pest control' })).toBeChecked();
    expect(within(services).getByRole('checkbox', { name: 'Flea treatment' })).not.toBeChecked();
    expect(within(services).getByText('HVAC inspection')).toBeInTheDocument();
    // The filters to bring, started from the tenant report.
    expect(screen.getByLabelText('Filter 1 size')).toHaveValue('20x25x1');
    expect(screen.getByLabelText('Filter 1 location')).toHaveValue('Hallway');
  });

  it('asks for filters only once the filter change is ticked', () => {
    render(card({ form: bookingForm(prefill, 'MOVE_IN'), inspectionType: 'MOVE_IN' }));

    expect(screen.getByRole('checkbox', { name: 'AC filter change' })).not.toBeChecked();
    expect(screen.queryByLabelText('Filter 1 size')).not.toBeInTheDocument();
    expect(screen.getByText('Move-in inspection')).toBeInTheDocument();
  });

  it('ticks a service on the form', () => {
    const onChange = vi.fn();
    render(card({ form: bookingForm(prefill, 'HVAC'), onChange }));

    fireEvent.click(screen.getByRole('checkbox', { name: 'Pest control' }));
    expect(onChange).toHaveBeenCalledWith(
      expect.objectContaining({ services: { filterChange: false, pestControl: true, fleaTreatment: false } }),
    );
  });

  it('lists what the server would refuse, and only for filters it would write', () => {
    const bad = [{ size: 'UPDATE', quantity: '', media: false, location: '' }];
    const { rerender } = render(card({ form: { ...ticked(), filters: bad } }));
    expect(screen.getByText('Fix before creating')).toBeInTheDocument();
    expect(screen.getByText('"UPDATE" is not a filter size like 20x25x1.')).toBeInTheDocument();

    rerender(card({ form: { ...ticked({ filterChange: false }), filters: bad } }));
    expect(screen.queryByText('Fix before creating')).not.toBeInTheDocument();
  });
});

describe('services on a visit not booked in Jobber from here', () => {
  it('gives the line to put in Jobber, the one the phone reads', () => {
    render(card({ booked: false }));

    const jobber = screen.getByRole('region', { name: 'For the visit in Jobber' });
    const line = within(jobber).getByText('Filter Change: 20x25x1 (Hallway) + Pest Control + HVAC Inspection');
    expect(parseVisitDetails(line.textContent).services).toMatchObject({ filterChange: true, pestControl: true });
    // Inside the create form, copying must not create the inspection.
    expect(within(jobber).getByRole('button', { name: /^Copy/ })).toHaveAttribute('type', 'button');
  });

  it('says nothing about Jobber when the booking carries them, or when none is ticked', () => {
    const { rerender } = render(card());
    expect(screen.queryByRole('region', { name: 'For the visit in Jobber' })).not.toBeInTheDocument();

    rerender(card({ booked: false, form: bookingForm(prefill, 'HVAC') }));
    expect(screen.queryByRole('region', { name: 'For the visit in Jobber' })).not.toBeInTheDocument();
  });
});
