import { render, screen, within } from '@testing-library/react';
import { describe, expect, it } from 'vitest';

import { JobberVisitDetails } from './jobber-visit-details';

/**
 * The office used to open Jobber beside every inspection for the filter sizes,
 * the tenant's number and the gate code. The people, numbers and codes here are
 * invented.
 */

const TITLE = '100 Main St - Zone 4 - Q3 2026 Tenant Benefit Package';
const DETAILS = `Filter Change: (2 pcs) 20x25x4 MEDIA; 12x24x1 in upstairs hallway + Pest Control + Occupied Inspection (Basic Plan - Opted Out HVAC Plan)

Make sure to contact tenants that you are on your way.
Tenant: Jane Q Sample (832) 555-0101

Gate Code: 4321 for tenant

Tenant has a very large dog and has no crates at this time

Instruction for completion
• Indicate in the notes which services were completed by using the corresponding numbers:
• Check for any potential repairs and create a work order if needed.`;

describe('the Jobber visit on an inspection', () => {
  it('shows the services, the plan and the filters to bring', () => {
    render(<JobberVisitDetails title={TITLE} details={DETAILS} inspectionType="OCCUPIED" />);

    expect(screen.getByText(TITLE)).toBeInTheDocument();
    const services = screen.getByRole('region', { name: 'Services' });
    for (const service of ['Filter change', 'Pest control', 'Occupied inspection'])
      expect(within(services).getByText(service)).toBeInTheDocument();
    expect(within(services).getByText('Basic plan · Opted out of the HVAC plan')).toBeInTheDocument();

    const filters = screen.getByRole('region', { name: 'Filters' });
    expect(within(filters).getByText('20x25x4')).toBeInTheDocument();
    expect(within(filters).getByText('× 2')).toBeInTheDocument();
    expect(within(filters).getByText('Media')).toBeInTheDocument();
    expect(within(filters).getByText('upstairs hallway')).toBeInTheDocument();
  });

  it('shows who to call, as a number the office can dial, and how to get in', () => {
    render(<JobberVisitDetails title={TITLE} details={DETAILS} inspectionType="OCCUPIED" />);

    const tenant = screen.getByRole('region', { name: 'Tenant' });
    expect(within(tenant).getByText('Contact the tenant before arriving.')).toBeInTheDocument();
    expect(within(tenant).getByText('Jane Q Sample')).toBeInTheDocument();
    expect(within(tenant).getByRole('link', { name: '(832) 555-0101' })).toHaveAttribute('href', 'tel:8325550101');
    expect(
      within(screen.getByRole('region', { name: 'Access' })).getByText('Gate Code: 4321 for tenant'),
    ).toBeInTheDocument();
    expect(
      within(screen.getByRole('region', { name: 'Notes' })).getByText(
        'Tenant has a very large dog and has no crates at this time',
      ),
    ).toBeInTheDocument();
  });

  it('keeps the completion steps and the text as written one click away', () => {
    render(<JobberVisitDetails title={TITLE} details={DETAILS} inspectionType="OCCUPIED" />);

    expect(screen.getByText('Completion steps (2)')).toBeInTheDocument();
    expect(screen.getByText('As written in Jobber')).toBeInTheDocument();
    expect(screen.getByText(/Filter Change: \(2 pcs\) 20x25x4 MEDIA/)).toBeInTheDocument();
  });

  it('warns when the Details say no occupied inspection is needed', () => {
    render(
      <JobberVisitDetails
        title={TITLE}
        details="Filter Change: Update Filter sizes + Pest Control + No need Occupied inspection since tenant just moved into the property"
        inspectionType="OCCUPIED"
      />,
    );
    expect(screen.getByText('The Details say no occupied inspection is needed')).toBeInTheDocument();
  });

  it('warns when an occupied inspection was imported from a visit that books only other work', () => {
    render(
      <JobberVisitDetails
        title={TITLE}
        details={'Filter Change: 20x25x5 + Pest Control\n\nInstruction for completion\n 3.HVAC / Occupied Inspection'}
        inspectionType="OCCUPIED"
      />,
    );
    expect(screen.getByText("The Details don't book an occupied inspection")).toBeInTheDocument();
    expect(screen.getByText(/They list filter change, pest control\./)).toBeInTheDocument();
  });

  it('shows what the technician reported, and a service to book again above everything else', () => {
    render(
      <JobberVisitDetails
        title={TITLE}
        details={DETAILS}
        inspectionType="OCCUPIED"
        servicesReport={{
          services: {
            filterChange: { done: true, reason: null, reschedule: false },
            pestControl: { done: false, reason: 'Tenant asked not to spray, has a newborn.', reschedule: true },
          },
          filtersInstalled: ['20x25x4', '12x24x1'],
          notes: 'Return air grille was blocked.',
        }}
        servicesReportedAt="2026-09-15T19:14:05.000Z"
      />,
    );

    expect(screen.getByText('Pest control to reschedule')).toBeInTheDocument();
    const reported = screen.getByRole('region', { name: 'Services done' });
    expect(within(reported).getByText('AC filter change')).toBeInTheDocument();
    expect(within(reported).getByText('Done')).toBeInTheDocument();
    expect(within(reported).getByText('Not done')).toBeInTheDocument();
    expect(within(reported).getByText('Reschedule')).toBeInTheDocument();
    expect(within(reported).getByText('20x25x4, 12x24x1')).toBeInTheDocument();
    expect(within(reported).getByText('Return air grille was blocked.')).toBeInTheDocument();
  });

  it('shows nothing for an inspection that did not come from Jobber', () => {
    const { container } = render(<JobberVisitDetails inspectionType="MOVE_IN" />);
    expect(container).toBeEmptyDOMElement();
  });
});
