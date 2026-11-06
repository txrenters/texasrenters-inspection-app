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

/** The card holding the instructions. */
const instructions = () => screen.getByText('Instructions').closest('details');
/** The card titled so: a dropdown, or a plain row with nothing more to show. */
const card = (title: string) => within(screen.getByRole('region', { name: 'Work done' })).getByText(title).closest('details');

/**
 * One Jobber visit that booked two jobs (2026-10-13): an HVAC inspection
 * holding the visit and an occupied inspection that follows it.
 */
describe('a visit booked as two jobs', () => {
  it('names the other job on the second one, which follows the visit and reads as in Jobber', () => {
    show({
      id: 'insp-occupied',
      scheduledInJobber: false,
      jobberCompanionOf: { id: 'insp-hvac', inspectionType: 'HVAC', status: 'SCHEDULED' },
    });

    const link = screen.getByRole('link', { name: 'HVAC inspection' });
    expect(link).toHaveAttribute('href', '/inspections/insp-hvac');
    expect(screen.getByText(/Its day, technician and Details follow that visit/)).toBeInTheDocument();
    // Not "isn't booked in Jobber from here": it is, through the first job.
    expect(screen.getByText('Jobber')).toBeInTheDocument();
    expect(screen.queryByText(/isn.t booked in Jobber/)).toBeNull();
  });

  it('names the second job on the first', () => {
    show({
      inspectionType: 'HVAC',
      jobberCompanions: [{ id: 'insp-occupied', inspectionType: 'OCCUPIED', status: 'SCHEDULED' }],
    });

    expect(screen.getByRole('link', { name: 'occupied inspection' })).toHaveAttribute('href', '/inspections/insp-occupied');
    expect(screen.getByText(/Jobber is told the visit is done once both are in/)).toBeInTheDocument();
  });
});

describe('the visit’s facts', () => {
  it('says who, when and how long', () => {
    show({
      status: 'REVIEW_REQUIRED',
      startedAt: '2026-10-01T22:49:00.000Z',
      submittedAt: '2026-10-02T00:45:00.000Z',
    });

    expect(screen.getByText('Sam Tech')).toBeInTheDocument();
    expect(screen.getByText('1 hr 56 min')).toBeInTheDocument();
    // Done when the technician submitted: the office's review is not the visit's.
    expect(screen.getAllByText('Done').length).toBeGreaterThan(0);
    expect(screen.getByText('Jobber')).toBeInTheDocument();
  });

  it('leaves the zone and the job number to the header, where they are said once', () => {
    show({ jobberJobNumber: '20625' });
    expect(screen.queryByText(/Job #20625/)).not.toBeInTheDocument();
    expect(screen.queryByText(/^Zone 4/)).not.toBeInTheDocument();
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

  it('leaves an imported record with no Jobber text, and its notes to the Notes section', () => {
    show({
      jobberVisitTitle: null,
      jobberVisitDetails: null,
      scheduledInJobber: false,
      internalNotes: 'Imported from an Inspect & Cloud PDF report. Inspector: Pat Example',
    });
    expect(screen.queryByText(/Imported from an Inspect & Cloud PDF report/)).toBeNull();
    expect(screen.queryByText('As written in Jobber')).toBeNull();
  });
});

describe('the tasks on a move-out', () => {
  // 3 nested fold-outs held these, then the same text again (the office,
  // 2026-10-05: "flat, boring, confusing").
  it('reads them as a plain list, with the additional ones under their own heading', () => {
    show({ inspectionType: 'MOVE_OUT', status: 'REVIEW_REQUIRED', jobberVisitDetails: MOVE_OUT_DETAILS });

    const tasks = screen.getByRole('region', { name: 'Tasks on the visit' });
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
    expect(instructions()).toHaveAttribute('open');
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
    const reported = screen.getByRole('region', { name: 'Work done' });
    expect(within(reported).getByText('AC filter change')).toBeInTheDocument();
    expect(within(reported).getByText('Done')).toBeInTheDocument();
    expect(within(reported).getByText('Not done')).toBeInTheDocument();
    expect(within(reported).getByText('To reschedule')).toBeInTheDocument();
    expect(within(reported).getByText('2 filters · 20x25x4, 12x24x1')).toBeInTheDocument();
    // Once, in the Notes section.
    expect(within(reported).queryByText('Return air grille was blocked.')).toBeNull();
  });

  it('has no Work done heading over nothing: a note alone belongs to the Notes section', () => {
    show({
      status: 'SCHEDULED',
      jobberVisitDetails: null,
      servicesReport: { services: {}, filtersInstalled: [], notes: 'Keys in the mailbox.' },
    });
    expect(screen.queryByRole('region', { name: 'Work done' })).toBeNull();
    expect(screen.queryByText('Keys in the mailbox.')).toBeNull();
  });

  it('folds the instructions away once the visit is done, leaving the work in view', () => {
    // A reviewer scrolled past a screen of filters to bring and gate codes to
    // reach the areas (the office, 2026-10-02): once submitted, that is history.
    show({ status: 'REVIEW_REQUIRED', servicesReport: report });

    expect(screen.getByRole('region', { name: 'Work done' }).closest('details')).toBeNull();
    const fold = instructions();
    expect(fold).not.toBeNull();
    expect(fold).not.toHaveAttribute('open');
    for (const region of ['Tasks on the visit', 'Services', 'Filters', 'Tenant', 'Access', 'Notes'])
      expect(fold).toContainElement(screen.getByRole('region', { name: region }));
    expect(fold).toContainElement(screen.getByText('As written in Jobber'));
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
    expect(screen.getByText('3 filters · 2 × 20x25x1, 16x20x1')).toBeInTheDocument();
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

/**
 * The visit as cards (the office, 2026-11-06): instructions first, then one card
 * for each thing done, its title and a line for a glance, with the rest in a
 * dropdown only where there is more to read.
 */
describe('the work as cards', () => {
  const done = { done: true, reason: null, reschedule: false };
  const filter = (over: Record<string, unknown> = {}) => ({
    size: '20x30x1',
    location: null,
    slot: 1,
    changed: true,
    reason: null,
    photoId: 'photo-1',
    booked: true,
    ...over,
  });
  const report = (over: Record<string, unknown> = {}) => ({
    services: { filterChange: done, pestControl: done },
    filters: [filter()],
    filtersInstalled: [],
    notes: null,
    ...over,
  });
  const finished = (servicesReport: unknown, over: Partial<AdminInspection> = {}) =>
    show({ status: 'REVIEW_REQUIRED', servicesReport: servicesReport as AdminInspection['servicesReport'], ...over });

  it('puts the instructions before the work', () => {
    finished(report());
    const order = instructions()!.compareDocumentPosition(screen.getByRole('region', { name: 'Work done' }));
    expect(order & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
  });

  it('keeps the instructions open during the job too, with a glance at what they hold', () => {
    show({ status: 'IN_PROGRESS' });
    expect(instructions()).toHaveAttribute('open');
    expect(screen.getByText('2 tasks · 3 filters to bring · tenant and access')).toBeInTheDocument();
  });

  it('shows a title, a line and how it went, with the filters in the card of the filter change', () => {
    finished(report());
    const filters = card('AC filter change');
    expect(filters).not.toHaveAttribute('open');
    expect(screen.getByText('1 filter · 20x30x1')).toBeInTheDocument();
    expect(filters).toContainElement(screen.getByRole('list', { name: 'Filter registers' }));
    // Said once: no count of filters beside the service, and no second line of them.
    expect(screen.queryByText(/Filters installed/)).toBeNull();
  });

  it('gives a card with nothing more to show no dropdown', () => {
    finished(report());
    expect(card('Pest control')).toBeNull();
  });

  it.each([
    ['not changed', filter({ changed: false, photoId: null, reason: 'Register painted over' })],
    ['a different size', filter({ actualSize: '20x25x1' })],
    ['not at the property', filter({ removed: true, changed: false, photoId: null })],
    ['with no photograph', filter({ photoId: null })],
  ])('opens by itself for a filter %s', (_name, odd) => {
    finished(report({ filters: [filter({ slot: 2 }), odd] }));
    expect(card('AC filter change')).toHaveAttribute('open');
  });

  it('opens by itself for a service not done, with the reason inside', () => {
    finished(report({ services: { filterChange: done, pestControl: { done: false, reason: 'Tenant refused', reschedule: true } } }));
    const pest = card('Pest control');
    expect(pest).toHaveAttribute('open');
    expect(pest).toContainElement(screen.getByText('Tenant refused', { selector: 'p' }));
  });

  it('gives any service the standard card, with no change to the page', () => {
    // Flea treatment says nothing of its own: this is what a new service gets.
    finished(report({ services: { fleaTreatment: { ...done, photoId: 'photo-flea', photoKey: 'k' } }, filters: [] }));
    expect(card('Flea treatment')).toContainElement(screen.getByRole('button', { name: 'Open Photo of this job - Flea treatment' }));
  });

  it('keeps a filter card for a report older than the registers, with the count alone', () => {
    finished({ services: { filterChange: done }, filtersInstalled: ['20x25x4'], notes: null });
    expect(screen.getByText('1 filter · 20x25x4')).toBeInTheDocument();
    expect(card('AC filter change')).toBeNull();
  });

  it('adds the inspection once the visit has begun, with how far the review has come', () => {
    render(
      <VisitCard
        areas={{ reviewed: 6, total: 7 }}
        inspection={inspection({ status: 'REVIEW_REQUIRED', servicesReport: report() as AdminInspection['servicesReport'] })}
      />,
    );
    expect(within(screen.getByRole('region', { name: 'Work done' })).getByText('Occupied inspection')).toBeInTheDocument();
    expect(screen.getByText('6 of 7 areas reviewed')).toBeInTheDocument();
  });

  it('has no inspection card where nobody got in: the alert says why', () => {
    show({ status: 'REVIEW_REQUIRED', completionBlockedReason: 'Could not get in: tenant not home' });
    expect(screen.queryByRole('region', { name: 'Work done' })).toBeNull();
  });

  it('says nothing of work before anybody has started, and a filter delivery is no inspection', () => {
    const { unmount } = show();
    expect(screen.queryByRole('region', { name: 'Work done' })).toBeNull();
    unmount();

    finished(report(), { inspectionType: 'AC_FILTER_DELIVERY' });
    const work = screen.getByRole('region', { name: 'Work done' });
    expect(within(work).getByText('AC filter change')).toBeInTheDocument();
    expect(within(work).queryByText('AC filter delivery')).toBeNull();
  });
});
