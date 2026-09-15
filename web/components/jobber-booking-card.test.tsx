import { parseVisitDetails, type JobberBookingContext } from '@texasrenters/shared';
import { render, screen, within } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';

import { bookingForm, bookingFromForm, bookingUnavailableReason } from '@/lib/jobber-booking';

import { JobberBookingCard } from './jobber-booking-card';

/**
 * Booking an occupied inspection's visit in Jobber from the create form.
 * People, addresses and numbers invented.
 */

const context = (overrides: Partial<JobberBookingContext> = {}): JobberBookingContext => ({
  enabled: true,
  connected: true,
  jobberProperty: { status: 'LINKED', address: '100 Main St' },
  address: '100 Main Street',
  prefill: {
    zone: 'Zone 3',
    benefitPackage: true,
    planTier: 'Basic',
    hvacOptedOut: true,
    filters: [{ size: '20x25x1', media: false, location: 'Hallway' }],
    tenants: [{ name: 'Jane Q Sample', phones: [] }],
  },
  technicianInJobber: true,
  ...overrides,
});

const card = (props: Partial<Parameters<typeof JobberBookingCard>[0]> = {}) => {
  const ready = props.context ?? context();
  return (
    <JobberBookingCard
      book
      context={ready}
      error={null}
      form={bookingForm(ready.prefill)}
      loading={false}
      onBookChange={vi.fn()}
      onChange={vi.fn()}
      scheduledOn="2026-10-06"
      {...props}
    />
  );
};

describe('the Jobber booking on the create form', () => {
  it('previews exactly what Jobber receives, started from the tenant report', () => {
    render(card());

    const preview = screen.getByRole('region', { name: 'What Jobber receives' });
    expect(within(preview).getByText('100 Main Street - Zone 3 - Q4 2026 Tenant Benefit Package')).toBeInTheDocument();
    expect(within(preview).getByText(/Filter Change: 20x25x1 \(Hallway\) \+ Pest Control \+ Occupied Inspection/)).toBeInTheDocument();
    expect(within(preview).getByText(/On the Jobber property at 100 Main St/)).toBeInTheDocument();
    expect(screen.getByLabelText('Tenant 1 name')).toHaveValue('Jane Q Sample');
  });

  it('says why a property cannot be booked, instead of offering the form', () => {
    render(card({ context: context({ jobberProperty: { status: 'NOT_LINKED', address: null } }) }));

    expect(screen.getByText("This visit won't be booked in Jobber")).toBeInTheDocument();
    expect(screen.getByRole('link', { name: 'Open the Jobber page' })).toHaveAttribute('href', '/integrations/jobber');
    expect(screen.queryByRole('switch')).not.toBeInTheDocument();
    expect(screen.queryByRole('region', { name: 'What Jobber receives' })).not.toBeInTheDocument();
  });

  it('warns that a technician it cannot match is booked unassigned', () => {
    render(card({ context: context({ technicianInJobber: false }) }));
    expect(screen.getByText(/booked unassigned\. Assign it in Jobber\./)).toBeInTheDocument();
  });

  it('lists what the server would refuse', () => {
    const ready = context();
    render(card({ form: { ...bookingForm(ready.prefill), filters: [{ size: 'UPDATE', quantity: '', media: false, location: '' }] } }));
    expect(screen.getByText('"UPDATE" is not a filter size like 20x25x1.')).toBeInTheDocument();
  });

  it('shows only a sentence when the coordinator turns the booking off', () => {
    render(card({ book: false }));
    expect(screen.getByText(/Not booked\./)).toBeInTheDocument();
    expect(screen.queryByLabelText('Tenant 1 name')).not.toBeInTheDocument();
  });
});

describe('the booking form as sent', () => {
  it('drops blank rows and splits the text into lines and paragraphs', () => {
    const sent = bookingFromForm({
      ...bookingForm(null),
      zone: ' Zone 2 ',
      filters: [
        { size: ' 16x25x1 ', quantity: '3', media: true, location: '' },
        { size: '', quantity: '1', media: false, location: 'nowhere' },
      ],
      tenants: [
        { name: 'Alex Doe', phones: '(281) 555-0103; (281) 555-0104', unit: '' },
        { name: ' ', phones: '', unit: '' },
      ],
      accessNotes: 'Gate Code: 1234\n\n Lockbox on the side gate ',
      notes: 'Dog in the yard\nkeep the gate shut\n\nTenant works nights',
    });

    expect(sent).toMatchObject({
      zone: 'Zone 2',
      filters: [{ size: '16x25x1', quantity: 3, media: true, location: null }],
      tenants: [{ name: 'Alex Doe', phones: ['(281) 555-0103', '(281) 555-0104'], unit: null }],
      accessNotes: ['Gate Code: 1234', 'Lockbox on the side gate'],
      notes: ['Dog in the yard\nkeep the gate shut', 'Tenant works nights'],
    });
  });

  it('starts an empty booking with the two services nearly every visit books', () => {
    expect(bookingFromForm(bookingForm(null))).toMatchObject({
      services: { filterChange: true, pestControl: true, fleaTreatment: false },
      filters: [],
      tenants: [],
      contactTenantsBeforeArrival: true,
    });
  });

  it('reads back through the parser the office visits go through', () => {
    const ready = context();
    render(card());
    const preview = screen.getByRole('region', { name: 'What Jobber receives' });
    const details = within(preview).getByText(/Instruction for completion/).textContent ?? '';
    expect(parseVisitDetails(details).tenants).toEqual(
      bookingFromForm(bookingForm(ready.prefill)).tenants.map((tenant) => ({ ...tenant, unit: null })),
    );
  });

  it('names the reason a booking is unavailable, most basic first', () => {
    expect(bookingUnavailableReason(context({ enabled: false, connected: false }))).toMatch(/switched off/);
    expect(bookingUnavailableReason(context({ connected: false }))).toMatch(/not connected/);
    expect(bookingUnavailableReason(context({ jobberProperty: { status: 'AMBIGUOUS', address: null } }))).toMatch(
      /more than one Jobber property/,
    );
    expect(bookingUnavailableReason(context())).toBeNull();
  });
});
