import type { AdminInspection } from '@texasrenters/shared';
import { render, screen, within } from '@testing-library/react';
import { describe, expect, it } from 'vitest';

import { VisitCard } from './visit-card';

/**
 * The visit, on an inspection's page: when, who, how long, what it was for and
 * what the technician reported. The people, numbers, codes and addresses here
 * are invented.
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

const MOVE_OUT_DETAILS = `Completion Instruction
• Conduct Move out inspection
 - Thoroughly check for any damages and Make work order
• Put additional notes if needed

Additional Task:
• Place Sign Supra Lockbox
• Take a picture of the sign supra and lockbox and upload it on jobber notes`;

function inspection(overrides: Partial<AdminInspection> = {}): AdminInspection {
  return {
    id: 'insp-1',
    status: 'SCHEDULED',
    inspectionType: 'OCCUPIED',
    priority: 'STANDARD',
    scheduledAt: '2026-10-01T00:00:00.000Z',
    createdAt: '2026-09-20T00:00:00.000Z',
    updatedAt: '2026-09-20T00:00:00.000Z',
    assignments: [],
    jobberVisitTitle: TITLE,
    jobberVisitDetails: DETAILS,
    scheduledInJobber: true,
    ...overrides,
  };
}

const show = (overrides: Partial<AdminInspection> = {}, technicianName: string | null = 'Sam Tech') =>
  render(<VisitCard inspection={inspection(overrides)} technicianName={technicianName} />);

describe('the visit’s facts', () => {
  it('says who, when, how long, and the zone the title names', () => {
    show({
      status: 'REVIEW_REQUIRED',
      startedAt: '2026-10-01T22:49:00.000Z',
      submittedAt: '2026-10-02T00:45:00.000Z',
    });

    expect(screen.getByText('Sam Tech')).toBeInTheDocument();
    expect(screen.getByText('Zone 4')).toBeInTheDocument();
    expect(screen.getByText('1 hr 56 min')).toBeInTheDocument();
    // Done when the technician submitted: the office's review is not the visit's.
    expect(screen.getByText('Done')).toBeInTheDocument();
    expect(screen.getByText('Jobber')).toBeInTheDocument();
  });

  it('asks for a technician before the visit, not after it', () => {
    show({}, null);
    expect(screen.getByText('Required before field work can start')).toBeInTheDocument();
  });

  it('says plainly when nobody could get in', () => {
    show({ status: 'REVIEW_REQUIRED', completionBlockedReason: 'Could not get in: tenant not home' });
    expect(screen.getByText('Could not get in')).toBeInTheDocument();
    expect(screen.getByText('Could not get in: tenant not home')).toBeInTheDocument();
  });

  it('shows where an imported record came from', () => {
    show({
      jobberVisitTitle: null,
      jobberVisitDetails: null,
      scheduledInJobber: false,
      internalNotes: 'Imported from an Inspect & Cloud PDF report. Inspector: Pat Example',
    });
    expect(screen.getByText(/Imported from an Inspect & Cloud PDF report/)).toBeInTheDocument();
    expect(screen.queryByText('As written in Jobber')).toBeNull();
  });
});

describe('the tasks on a move-out', () => {
  // 3 nested fold-outs held these, then the same text again (the office,
  // 2026-10-05: "flat, boring, confusing").
  it('reads them as a plain list, with the additional ones under their own heading', () => {
    show({ inspectionType: 'MOVE_OUT', status: 'REVIEW_REQUIRED', jobberVisitDetails: MOVE_OUT_DETAILS });

    const tasks = screen.getByRole('region', { name: 'Tasks on the visit' });
    expect(tasks.closest('details')).toBeNull();
    expect(within(tasks).getByText('Conduct Move out inspection')).toBeInTheDocument();
    expect(within(tasks).getByText('Additional Task')).toBeInTheDocument();
    expect(within(tasks).getByText('Place Sign Supra Lockbox')).toBeInTheDocument();
    // The office's own heading is not a task.
    expect(within(tasks).queryByText('Completion Instruction')).toBeNull();
    expect(screen.queryByText(/Completion steps/)).toBeNull();
  });
});

describe('the services on an inspection that is not in Jobber', () => {
  it('says Jobber needs the services too', () => {
    show({
      jobberVisitTitle: null,
      jobberVisitDetails: 'Filter Change: 20x25x1 + Pest Control + HVAC Inspection',
      scheduledInJobber: false,
      inspectionType: 'HVAC',
    });

    expect(screen.queryByText('Jobber')).toBeNull();
    expect(screen.getByText(/isn.t booked in Jobber from here/)).toBeInTheDocument();
    const services = screen.getByRole('region', { name: 'Services' });
    for (const service of ['Filter change', 'Pest control', 'HVAC Inspection'])
      expect(within(services).getByText(service)).toBeInTheDocument();
    expect(screen.getByText('As written')).toBeInTheDocument();
  });
});

describe('the Jobber visit before it is done', () => {
  it('shows the services, the plan and the filters to bring', () => {
    show();

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
    show();

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
    // Before the visit, all of it is open.
    expect(screen.queryByText('Before the visit')).toBeNull();
  });

  it('keeps the text as written, title included, one click away', () => {
    show();
    expect(screen.getByText('As written in Jobber')).toBeInTheDocument();
    expect(screen.getByText(TITLE)).toBeInTheDocument();
    expect(screen.getByText(/Filter Change: \(2 pcs\) 20x25x4 MEDIA/)).toBeInTheDocument();
  });

  it('warns when the Details say no occupied inspection is needed', () => {
    show({
      jobberVisitDetails:
        'Filter Change: Update Filter sizes + Pest Control + No need Occupied inspection since tenant just moved into the property',
    });
    expect(screen.getByText('The Details say no occupied inspection is needed')).toBeInTheDocument();
  });

  it('warns when an occupied inspection was imported from a visit that books only other work', () => {
    show({
      jobberVisitDetails: 'Filter Change: 20x25x5 + Pest Control\n\nInstruction for completion\n 3.HVAC / Occupied Inspection',
    });
    expect(screen.getByText("The Details don't book an occupied inspection")).toBeInTheDocument();
    expect(screen.getByText(/They list filter change, pest control\./)).toBeInTheDocument();
  });

  it('says when this console booked the visit, and when Jobber would not take it', () => {
    const { rerender } = show({
      jobberBooking: { status: 'SENT', attempts: 1, lastError: null, sentAt: '2026-10-01T15:00:00.000Z' },
    });
    expect(screen.getByText('Booked from this console')).toBeInTheDocument();

    rerender(
      <VisitCard
        inspection={inspection({
          jobberBooking: {
            status: 'ABANDONED',
            attempts: 1,
            lastError: 'The inspection was cancelled before its visit was booked in Jobber.',
            sentAt: null,
          },
        })}
      />,
    );
    expect(screen.getByText('This visit was not booked in Jobber')).toBeInTheDocument();
    expect(screen.queryByText('Booked from this console')).not.toBeInTheDocument();
  });

  it('says which console changes are still on their way to Jobber, and which it refused', () => {
    render(
      <VisitCard
        action={<button type="button">Edit visit</button>}
        inspection={inspection({
          jobberPushes: [
            { kind: 'VISIT_RESCHEDULE', status: 'PENDING', attempts: 0, lastError: null },
            { kind: 'VISIT_ASSIGN', status: 'ABANDONED', attempts: 6, lastError: 'Jobber rejected the update.' },
          ],
        })}
      />,
    );

    expect(screen.getByText('Sending the new date to Jobber')).toBeInTheDocument();
    expect(screen.getByText('Jobber did not take the technician')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Edit visit' })).toBeInTheDocument();
  });
});

describe('what the technician reported', () => {
  const report = {
    services: {
      filterChange: { done: true, reason: null, reschedule: false },
      pestControl: { done: false, reason: 'Tenant asked not to spray, has a newborn.', reschedule: true },
    },
    filtersInstalled: ['20x25x4', '12x24x1'],
    notes: 'Return air grille was blocked.',
  };

  it('shows it, and a service to book again above everything else', () => {
    show({ servicesReport: report, servicesReportedAt: '2026-09-15T19:14:05.000Z' });

    expect(screen.getByText('Pest control to reschedule')).toBeInTheDocument();
    const reported = screen.getByRole('region', { name: 'Services done' });
    expect(within(reported).getByText('AC filter change')).toBeInTheDocument();
    expect(within(reported).getByText('Done')).toBeInTheDocument();
    expect(within(reported).getByText('Not done')).toBeInTheDocument();
    expect(within(reported).getByText('Reschedule')).toBeInTheDocument();
    expect(within(reported).getByText('2 filters: 1 × 20x25x4, 1 × 12x24x1')).toBeInTheDocument();
    expect(within(reported).getByText('Return air grille was blocked.')).toBeInTheDocument();
  });

  it('keeps it open once the visit is done, and folds the planning detail away', () => {
    // A reviewer scrolled past a screen of filters to bring and gate codes to
    // reach the areas (the office, 2026-10-02): once submitted, that is history.
    show({ status: 'REVIEW_REQUIRED', servicesReport: report });

    expect(screen.getByRole('region', { name: 'Services done' }).closest('details')).toBeNull();
    const fold = screen.getByText('Before the visit').closest('details');
    expect(fold).not.toBeNull();
    expect(fold).not.toHaveAttribute('open');
    for (const region of ['Services', 'Filters', 'Tenant', 'Access', 'Notes'])
      expect(fold).toContainElement(screen.getByRole('region', { name: region }));
  });

  it('shows each filter register the technician answered for', () => {
    // The office asked for a photograph of every register (2026-09-18), so the
    // console has to show which ones were changed and which were missed.
    show({
      servicesReport: {
        services: { filterChange: { done: true, reason: null, reschedule: false } },
        filters: [
          { size: '20x25x1', location: 'upstairs hallway', slot: 1, changed: true, reason: null, photoId: 'photo-1', booked: true },
          { size: '20x25x1', location: 'upstairs hallway', slot: 2, changed: true, reason: null, photoId: null, photoKey: 'snapshot-2', booked: true },
          { size: '12x12x1', location: 'downstairs', slot: 1, changed: false, reason: 'Register painted over', photoId: null, booked: true },
          { size: '16x20x1', location: null, slot: 1, changed: true, reason: null, photoId: 'photo-4', booked: false },
        ],
        filtersInstalled: [],
        notes: null,
      },
    });

    const registers = screen.getByRole('list', { name: 'Filter registers' });
    expect(within(registers).getAllByText('Changed')).toHaveLength(3);
    expect(within(registers).getByText('Register painted over')).toBeInTheDocument();
    expect(within(registers).getByText('Photograph still uploading')).toBeInTheDocument();
    expect(within(registers).getByText('Found on site')).toBeInTheDocument();
    expect(screen.getByText('3 filters: 2 × 20x25x1, 1 × 16x20x1')).toBeInTheDocument();
  });

  // 5706 Micah Ln read "still uploading" for four days after the job was
  // submitted: the office waited for a photograph that was never coming.
  it('calls a photograph missing a day after the job was submitted, not still uploading', () => {
    show({
      status: 'REVIEW_REQUIRED',
      submittedAt: new Date(Date.now() - 3 * 24 * 60 * 60 * 1000).toISOString(),
      servicesReport: {
        services: { filterChange: { done: true, reason: null, reschedule: false } },
        filters: [
          { size: '16x25x1', location: null, slot: 1, changed: true, reason: null, photoId: null, photoKey: 'snapshot-1', booked: true },
        ],
        filtersInstalled: [],
        notes: null,
      },
    });

    expect(screen.getByText('Photograph never arrived')).toBeInTheDocument();
    expect(screen.queryByText('Photograph still uploading')).toBeNull();
  });

  it('shows one photograph of all the filters once, named for every filter in it', () => {
    const register = (size: string, location: string) => ({
      size,
      location,
      slot: 1,
      changed: true,
      reason: null,
      photoId: 'photo-stack',
      photoKey: 'snapshot-stack',
      booked: true,
    });
    show({
      servicesReport: {
        services: {
          filterChange: { done: true, reason: null, reschedule: false },
          pestControl: { done: true, reason: null, reschedule: false, photoKey: 'snapshot-p', photoId: 'photo-pest' },
        },
        filters: [register('20x25x1', 'upstairs hallway'), register('12x12x1', 'downstairs')],
        filtersInstalled: [],
        notes: null,
      },
    });

    expect(screen.getAllByRole('button', { name: /^Open Serial or label/ })).toHaveLength(1);
    expect(
      screen.getByRole('button', {
        name: 'Open Serial or label of this job - 20x25x1 · upstairs hallway, 12x12x1 · downstairs',
      }),
    ).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Open Photo of this job - Pest control' })).toBeInTheDocument();
  });
});
