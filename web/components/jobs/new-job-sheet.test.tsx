import type { AdminJob, CreateJobInput } from '@texasrenters/shared';
import { fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { ApiError } from '@/lib/api';

/**
 * The New job panel (2026-11-20, phase 2 of the jobs plan): one job, its
 * number and title, every inspection ticked, saved in one request. People,
 * addresses and ids invented.
 */

const state = vi.hoisted(() => ({
  units: [] as { id: string; name: string; isActive: boolean }[],
  createError: null as Error | null,
  saved: [] as unknown[],
  job: null as unknown,
}));
const router = vi.hoisted(() => ({ push: vi.fn() }));
vi.mock('next/navigation', () => ({ useRouter: () => router }));

const property = {
  id: 'p1',
  name: '2210 Example Bend',
  addressLine1: '2210 Example Bend',
  city: 'Testville',
  state: 'TX',
  postalCode: '00000',
  isActive: true,
};
const idle = { data: undefined, isLoading: false, isError: false, error: null };

vi.mock('@/lib/queries', () => ({
  useNextJobNumber: () => ({ data: { number: 'J-00042' }, isLoading: false }),
  useProperty: (id: string) => (id ? { data: property, isLoading: false } : idle),
  usePropertyOptions: () => ({ ...idle, data: { pages: [{ items: [property] }] }, hasNextPage: false, isFetchingNextPage: false, fetchNextPage: vi.fn() }),
  useUnits: (id: string) => (id ? { ...idle, data: { items: state.units } } : idle),
  useLeases: () => ({ ...idle, data: { items: [] } }),
  useTechnicians: () => ({ ...idle, data: { items: [{ id: 't1', displayName: 'D. Sample' }] } }),
  usePropertyAreas: (id: string) =>
    id ? { ...idle, data: [{ id: 'a1', name: 'Kitchen', status: 'APPROVED', unitId: null, source: 'IMPORTED', _count: {} }] } : idle,
  // Jobber booking is switched off here, so nothing is booked there.
  useJobberBookingContext: () => ({
    ...idle,
    isPlaceholderData: false,
    data: { enabled: false, connected: false, jobberProperty: { status: 'NOT_LINKED', address: null }, address: '', prefill: null },
  }),
  useCreateJob: () => ({
    isPending: false,
    error: state.createError,
    reset: vi.fn(),
    mutateAsync: async (input: unknown) => {
      state.saved.push(input);
      return state.job;
    },
  }),
}));

const { NewJobSheet } = await import('./new-job-sheet');

const job = (over: Partial<AdminJob> = {}): AdminJob => ({
  id: 'job-1',
  number: 'J-00042',
  title: 'Occupied + HVAC, filters and pest control',
  source: 'CONSOLE',
  scheduledAt: '2026-11-23',
  property: { id: 'p1', name: '2210 Example Bend', addressLine1: '2210 Example Bend' },
  unit: null,
  createdAt: '2026-11-20T15:00:00.000Z',
  state: 'SCHEDULED',
  technician: null,
  services: [],
  canAddWork: true,
  inspections: [
    { id: 'hvac-1', inspectionType: 'HVAC', status: 'SCHEDULED', state: 'SCHEDULED', lead: true, technician: null, canTakeOff: false },
    { id: 'occupied-1', inspectionType: 'OCCUPIED', status: 'SCHEDULED', state: 'SCHEDULED', lead: false, technician: null, canTakeOff: true },
  ],
  ...over,
});

function open(prefill: Parameters<typeof NewJobSheet>[0]['prefill'] = {}) {
  const onClose = vi.fn();
  render(<NewJobSheet onClose={onClose} prefill={{ date: '2026-11-23', propertyId: 'p1', ...prefill }} />);
  return { onClose, panel: screen.getByRole('dialog') };
}

const saved = () => state.saved as CreateJobInput[];
const tick = (name: string) => fireEvent.click(screen.getByRole('checkbox', { name }));

beforeEach(() => {
  state.units = [];
  state.createError = null;
  state.saved = [];
  state.job = job();
  router.push.mockClear();
});

describe('the New job panel', () => {
  it('opens on the day it was given, with the next number and the inspection ticked', () => {
    open({ inspectionTypes: ['OCCUPIED'], from: 'from the Schedule' });

    expect(screen.getByText('Monday, November 23 · from the Schedule')).toBeTruthy();
    expect((screen.getByLabelText('Job number') as HTMLInputElement).value).toBe('J-00042');
    expect(screen.getByRole('checkbox', { name: 'Occupied' }).getAttribute('data-state')).toBe('checked');
    // An occupied visit's filter change and pest control, and the title follows them.
    expect((screen.getByLabelText('Title') as HTMLInputElement).placeholder).toBe(
      'Occupied, filters and pest control',
    );
  });

  it('says what saving makes: each inspection, the services on the lead, one alert', () => {
    open({ inspectionTypes: ['OCCUPIED', 'HVAC'], technicianId: 't1' });

    const summary = screen.getByRole('status');
    expect(within(summary).getByText('Saving makes job J-00042')).toBeTruthy();
    expect(within(summary).getByText('2 inspections: Occupied and HVAC, each with its own report')).toBeTruthy();
    expect(within(summary).getByText('On the HVAC inspection: AC filter change and Pest control')).toBeTruthy();
    expect(within(summary).getByText('D. Sample gets one alert for the whole job')).toBeTruthy();
  });

  it('saves the job in one request, leaving the number to the server when nobody typed one', async () => {
    const { onClose } = open({ inspectionTypes: ['OCCUPIED'] });
    tick('HVAC');
    fireEvent.click(screen.getByRole('button', { name: 'Save job' }));

    await waitFor(() => expect(onClose).toHaveBeenCalled());
    expect(saved()).toHaveLength(1);
    expect(saved()[0]).toMatchObject({
      propertyId: 'p1',
      scheduledAt: '2026-11-23T00:00:00.000Z',
      inspectionTypes: ['OCCUPIED', 'HVAC'],
      visitServices: { services: { filterChange: true, pestControl: true, fleaTreatment: false }, filters: [] },
    });
    expect(saved()[0]!.number).toBeUndefined();
    expect(saved()[0]!.title).toBeUndefined();
    expect(saved()[0]!.jobberBooking).toBeUndefined();
    expect(saved()[0]!.requestKey).toMatch(/^[0-9a-f-]{36}$/);
    expect(router.push).not.toHaveBeenCalled();
  });

  it('sends a number and a title only when the office typed them', async () => {
    const { onClose } = open({ inspectionTypes: ['MOVE_OUT'] });
    fireEvent.change(screen.getByLabelText('Job number'), { target: { value: 'wo 48213' } });
    fireEvent.change(screen.getByLabelText('Title'), { target: { value: 'Move-out and the sink' } });
    fireEvent.click(screen.getByRole('button', { name: 'Save job' }));

    await waitFor(() => expect(onClose).toHaveBeenCalled());
    expect(saved()[0]).toMatchObject({ number: 'wo 48213', title: 'Move-out and the sink' });
  });

  it('keeps one request key for every press, so a retry makes no second job', async () => {
    state.job = job();
    const { onClose } = open({ inspectionTypes: ['MOVE_OUT'] });
    fireEvent.click(screen.getByRole('button', { name: 'Save job' }));
    await waitFor(() => expect(onClose).toHaveBeenCalledTimes(1));
    fireEvent.click(screen.getByRole('button', { name: 'Save job' }));
    await waitFor(() => expect(saved()).toHaveLength(2));
    expect(saved()[1]!.requestKey).toBe(saved()[0]!.requestKey);
  });

  it('opens the job page after "Save and open"', async () => {
    open({ inspectionTypes: ['OCCUPIED', 'HVAC'] });
    fireEvent.click(screen.getByRole('button', { name: 'Save and open' }));

    await waitFor(() => expect(router.push).toHaveBeenCalledWith('/jobs/job-1'));
  });

  it('will not save a job with no inspection, and says services alone come later', () => {
    open();

    expect(screen.getByText('Tick at least one inspection.')).toBeTruthy();
    expect(screen.getByText(/A job of services alone comes with the next phone update/)).toBeTruthy();
    expect((screen.getByRole('button', { name: 'Save job' }) as HTMLButtonElement).disabled).toBe(true);
  });

  it('offers no services on a job whose only inspection cannot carry them', () => {
    open({ inspectionTypes: ['ROOF'] });

    expect(screen.getByText(/Services go with an occupied, move-in, move-out, back-to-market or HVAC inspection/)).toBeTruthy();
    expect(screen.queryByRole('checkbox', { name: 'Pest control' })).toBeNull();
  });

  it('asks for the unit at a property with units', () => {
    state.units = [
      { id: 'u1', name: 'Unit A', isActive: true },
      { id: 'u2', name: 'Unit B', isActive: true },
    ];
    open({ inspectionTypes: ['OCCUPIED'] });

    expect(screen.getByText('Choose the unit.')).toBeTruthy();
    expect((screen.getByRole('button', { name: 'Save job' }) as HTMLButtonElement).disabled).toBe(true);
  });

  it('refuses a number that cannot be one before anything is sent', () => {
    open({ inspectionTypes: ['OCCUPIED'] });
    fireEvent.change(screen.getByLabelText('Job number'), { target: { value: '#42!' } });

    expect(screen.getByText('Letters and digits, with - / . or _ between them, at most 40.')).toBeTruthy();
    expect((screen.getByRole('button', { name: 'Save job' }) as HTMLButtonElement).disabled).toBe(true);
  });

  it('leaves the job with nobody when the technician handed over is not an active one', async () => {
    const { onClose } = open({ inspectionTypes: ['MOVE_OUT'], technicianId: 'gone' });
    expect(screen.getByRole('combobox', { name: 'Technician' }).textContent).toBe('Nobody yet');
    fireEvent.click(screen.getByRole('button', { name: 'Save job' }));

    await waitFor(() => expect(onClose).toHaveBeenCalled());
    expect(saved()[0]!.technicianId).toBeUndefined();
  });

  it('says under the number when another job has it', () => {
    state.createError = new ApiError(409, 'JOB_NUMBER_TAKEN', 'J-00007 is already the number of "Move-out".');
    open({ inspectionTypes: ['OCCUPIED'] });

    const field = screen.getByLabelText('Job number').closest('[data-slot="field"]') as HTMLElement;
    expect(within(field).getByText('J-00007 is already the number of "Move-out".')).toBeTruthy();
  });
});
