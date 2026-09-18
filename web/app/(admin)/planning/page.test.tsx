import { fireEvent, render, screen, within } from '@testing-library/react';
import { toast } from 'sonner';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import PlanningPage from './page';

const hooks = vi.hoisted(() => ({
  usePlanQuarters: vi.fn(),
  usePlanStops: vi.fn(),
  usePlanDays: vi.fn(),
  usePlanDayRoute: vi.fn(),
  usePlanRotation: vi.fn(),
  usePlanTechnicians: vi.fn(),
  usePlanningMutations: vi.fn(),
}));

vi.mock('@/lib/planning-queries', () => hooks);
vi.mock('@/lib/auth', () => ({ usePermissions: () => ({ has: () => true }) }));
const url = vi.hoisted(() => ({ state: { quarter: '2026-4', tab: 'days', day: '' }, set: vi.fn() }));
vi.mock('@/lib/url-state', () => ({ useUrlState: () => [url.state, url.set] }));
// The map loads Google's script; the page around it is what is under test.
vi.mock('@/components/planning/plan-day-map', () => ({ PlanDayMap: () => <div data-testid="plan-day-map" /> }));

const idle = { mutate: vi.fn(), isPending: false };
const build = { mutate: vi.fn(), isPending: false };

const PLAN = {
  id: 'plan-1',
  quarterYear: 2026,
  quarterNumber: 4,
  quarterStartsOn: '2026-10-01T00:00:00.000Z',
  status: 'DRAFT',
  stopCount: 3,
  blockedCount: 0,
  publishedCount: 0,
  unverifiedEnrollmentCount: 0,
  generatedAt: '2026-09-16T10:00:00.000Z',
  publishedAt: null,
  lastError: null,
  officeDetailsImportedAt: '2026-09-16T10:05:00.000Z',
  hvacStopCount: 1,
  occupiedStopCount: 2,
  occupiedVisitMinutes: 30,
  hvacVisitMinutes: 45,
  maxOnSiteMinutes: 360,
  maxDriveMinutes: 90,
  minStopsPerDay: 9,
  maxStopsPerDay: 12,
  holidays: ['2026-11-26'],
};

const stop = (id: string, overrides: Record<string, unknown> = {}) => ({
  id,
  sequence: Number(id.slice(1)),
  previousSequence: null,
  orderSource: 'PRIOR_QUARTER',
  zone: '1',
  scheduledOn: '2026-10-01T00:00:00.000Z',
  positionInDay: Number(id.slice(1)),
  assignedTechnicianId: 'tech-1',
  assignedTechnician: { id: 'tech-1', displayName: 'Moses Rivera' },
  unitResolution: 'NO_UNITS',
  status: 'PLANNED',
  blockedCode: null,
  blockedMessage: null,
  inspectionType: 'OCCUPIED',
  inspectionTypeReason: 'HVAC_PLAN_NOT_ADDED',
  inspectionTypeNeedsReview: false,
  inspectionTypeOverriddenAt: null,
  onSiteMinutes: 30,
  driveSecondsForecast: 600,
  officeDetails: 'Filter Change: 20x25x1 + Pest Control + Occupied Inspection',
  visitTitle: `${id} Any St - Zone 1 - Q4 2026 Tenant Benefit Package`,
  visitDetails: 'Filter Change: 20x25x1 + Pest Control + Occupied Inspection\n\nInstruction for completion',
  inspectionId: null,
  jobberVisitId: null,
  hvacFilterSizes: ['20x25x1'],
  scheduleOverriddenAt: null,
  technicianOverriddenAt: null,
  visitTitleOverriddenAt: null,
  visitDetailsOverriddenAt: null,
  onSiteMinutesOverriddenAt: null,
  unitOverriddenAt: null,
  previousTechnician: { id: 'tech-1', displayName: 'Moses Rivera' },
  propertywareUnit: null,
  buildingUnits: [],
  tenant: {
    leaseName: `Tenant of ${id}`,
    addressLine1: `${id} Any St`,
    city: 'Katy',
    state: 'TX',
    postalCode: '77494',
    managementPlan: 'Standard',
    hvacPlan: 'Not Completed',
    startDate: '2026-01-01T00:00:00.000Z',
    endDate: '2026-12-31T00:00:00.000Z',
    hvacFilterLocation: 'Hallway ceiling',
    hvacFilterSizes: ['20x25x1'],
    lastFilterDelivery: 'Q3 2026',
    lastHvacInspection: null,
    lastOccupiedInspection: 'Q3 2026',
  },
  ...overrides,
});

const DAY = {
  id: 'day-1',
  date: '2026-10-01T00:00:00.000Z',
  technicianId: 'tech-1',
  technician: { id: 'tech-1', displayName: 'Moses Rivera' },
  stopCount: 3,
  onSiteMinutes: 105,
  hvacStopCount: 1,
  totalDriveSeconds: 1200,
  totalDriveMeters: 14000,
  originKind: 'FIRST_STOP',
  durationSource: 'GOOGLE_TRAFFIC_AWARE',
  departureAssumedAt: '2026-10-01T14:00:00.000Z',
  stops: [
    { id: 's1', sequence: 1, positionInDay: 1, inspectionType: 'OCCUPIED', onSiteMinutes: 30, driveSecondsForecast: null, zone: '1', status: 'PLANNED', address: '1 Any St', city: 'Katy', latitude: 29.7, longitude: -95.7 },
    { id: 's2', sequence: 2, positionInDay: 2, inspectionType: 'HVAC', onSiteMinutes: 45, driveSecondsForecast: 600, zone: '1', status: 'PLANNED', address: '2 Any St', city: 'Katy', latitude: 29.71, longitude: -95.7 },
    { id: 's3', sequence: 3, positionInDay: 3, inspectionType: 'OCCUPIED', onSiteMinutes: 30, driveSecondsForecast: 600, zone: '1', status: 'PLANNED', address: '3 Any St', city: 'Katy', latitude: 29.72, longitude: -95.7 },
  ],
};

function mount({
  plans = [PLAN],
  stops = [stop('s1'), stop('s2', { inspectionType: 'HVAC' }), stop('s3')],
  day = DAY as Record<string, unknown>,
} = {}) {
  hooks.usePlanQuarters.mockReturnValue({ isLoading: false, isError: false, data: plans });
  hooks.usePlanStops.mockReturnValue({ isLoading: false, isError: false, data: stops });
  hooks.usePlanDays.mockReturnValue({ isLoading: false, isError: false, data: plans.length ? [day] : [] });
  hooks.usePlanDayRoute.mockReturnValue({ isSuccess: true, data: { source: 'GOOGLE_TRAFFIC_AWARE', geometry: [[29.7, -95.7], [29.72, -95.7]], legs: [] } });
  hooks.usePlanRotation.mockReturnValue({
    isSuccess: true,
    data: {
      crew: [
        { technicianId: 'tech-1', displayName: 'Moses Rivera', hasHome: true },
        { technicianId: 'tech-2', displayName: 'Kevin Grant', hasHome: true },
        { technicianId: 'tech-3', displayName: 'Emanuel Hall', hasHome: true },
      ],
      zones: ['1', '2', '3', '4'],
      outOfReach: ['5'],
      weeks: [
        {
          weekOf: '2026-09-28',
          zones: [
            { zone: '1', technicianId: 'tech-1' },
            { zone: '2', technicianId: 'tech-2' },
            { zone: '3', technicianId: 'tech-3' },
          ],
        },
        {
          weekOf: '2026-10-05',
          zones: [
            { zone: '2', technicianId: 'tech-1' },
            { zone: '3', technicianId: 'tech-2' },
            { zone: '4', technicianId: 'tech-3' },
          ],
        },
      ],
    },
  });
  hooks.usePlanTechnicians.mockReturnValue({ data: [] });
  hooks.usePlanningMutations.mockReturnValue({
    build,
    editStop: idle,
    importOfficeDetails: idle,
    setType: idle,
    exclude: idle,
    publish: idle,
  });
  return render(<PlanningPage />);
}

beforeEach(() => {
  vi.clearAllMocks();
  url.state = { quarter: '2026-4', tab: 'days', day: '' };
});

describe('the benefit package plan page', () => {
  it('offers to build a quarter that has no plan yet', () => {
    mount({ plans: [] });

    expect(screen.getByText('No plan for Q4 2026 yet')).toBeTruthy();
    expect(screen.getByRole('button', { name: /Build the Q4 2026 plan/ })).toBeTruthy();
  });

  /** The office found a form of visit minutes and closed days confusing (2026-09-16): building asks nothing. */
  it('builds a quarter in one click, with nothing to fill in', () => {
    mount({ plans: [] });

    fireEvent.click(screen.getByRole('button', { name: /Build the Q4 2026 plan/ }));

    expect(build.mutate).toHaveBeenCalledWith({ year: 2026, quarter: 4 }, expect.anything());
    expect(screen.queryByRole('dialog')).toBeNull();
  });

  it('rebuilds a draft in one click', () => {
    mount();

    fireEvent.click(screen.getByRole('button', { name: 'Rebuild' }));

    expect(build.mutate).toHaveBeenCalledWith({ year: 2026, quarter: 4 }, expect.anything());
    expect(screen.queryByRole('dialog')).toBeNull();
    expect(screen.queryByRole('button', { name: 'Lay out days' })).toBeNull();
  });

  /** A build takes minutes (244 s for Q4 2026); a spinner alone read as a hung page. */
  it('says a build takes a few minutes while it runs, in the toast its result replaces', () => {
    const loading = vi.spyOn(toast, 'loading');
    mount();

    fireEvent.click(screen.getByRole('button', { name: 'Rebuild' }));

    expect(loading).toHaveBeenCalledWith('Building Q4 2026', {
      id: 'plan-build-2026-4',
      description: expect.stringContaining('takes a few minutes'),
    });
    const [, handlers] = build.mutate.mock.calls.at(-1)! as [unknown, { onError: (error: Error) => void }];
    const error = vi.spyOn(toast, 'error');
    handlers.onError(new Error('The Q4 2026 plan is already being built, since 1:48 PM Central.'));
    expect(error).toHaveBeenCalledWith('Q4 2026 could not be planned', {
      id: 'plan-build-2026-4',
      description: 'The Q4 2026 plan is already being built, since 1:48 PM Central.',
    });
  });

  /** The office asked for the quarter as a calendar too (2026-09-17). */
  it('shows the plan as a calendar, and opens a day picked there in the Days tab', () => {
    url.state = { quarter: '2026-4', tab: 'calendar', day: '' };
    mount();

    fireEvent.click(screen.getByRole('button', { name: /^Thursday, October 1: Moses Rivera, 3 visits/ }));

    expect(url.set).toHaveBeenCalledWith({ tab: 'days', day: 'day-1' });
  });

  it('states the working days and the day limits in plain words', () => {
    mount();

    // The quarter's US holidays, found by the planner rather than typed in.
    expect(screen.getByText('Weekdays except US holidays: Oct 12, Nov 11, Nov 26, Dec 25')).toBeTruthy();
    expect(screen.getByText('9 to 12 visits and up to 6 hr inspecting a day')).toBeTruthy();
    expect(screen.getByText('9 to 12 every day, the whole crew every day until every visit has one')).toBeTruthy();
    // Driving has no limit to show (2026-09-17).
    expect(screen.queryByText(/90 min/)).toBeNull();
    expect(screen.queryByText(/360/)).toBeNull();
    // Thanksgiving is on the plan as well, and is a holiday rather than another closed day.
    expect(screen.queryByText('Also closed')).toBeNull();
  });

  it('shows a day against the office’s limits, with its clock', async () => {
    mount();

    const day = screen.getByRole('region', { name: /Thursday, October 1, Moses Rivera/ });
    expect(within(day).getByText('1 hr 45 min of 6 hr')).toBeTruthy();
    expect(within(day).getByText(/20 min between properties/)).toBeTruthy();
    // Nine o'clock at the first property, then ten minutes' drive to each of the next.
    expect(within(day).getByText('9:00 AM – 9:30 AM')).toBeTruthy();
    expect(within(day).getByText('9:40 AM – 10:25 AM')).toBeTruthy();
    expect(within(day).getByText('HVAC inspection')).toBeTruthy();
    // Loaded after the page, as the real map is.
    expect(await screen.findByTestId('plan-day-map')).toBeTruthy();
  });

  /** The office (2026-09-17): move-outs are Moses's, and TBPs are done around them. */
  it('shows the move-out a day is built around, and asks to reassign one that is not the day’s technician’s', () => {
    mount({
      day: {
        ...DAY,
        onSiteMinutes: 165,
        stops: DAY.stops.map((stop, index) => ({ ...stop, positionInDay: index === 0 ? 1 : index + 2 })),
        anchors: [
          {
            id: 'anchor-1',
            inspectionId: 'insp-9',
            positionInDay: 2,
            onSiteMinutes: 60,
            driveSecondsForecast: 600,
            address: '9 Move Out Ln',
            city: 'Katy',
            latitude: 29.705,
            longitude: -95.7,
            assignedTechnician: { id: 'amy', displayName: 'Amy Wilson' },
            needsReassigning: true,
            scheduledOn: '2026-10-01',
            cancelled: false,
          },
        ],
      },
    });

    const day = screen.getByRole('region', { name: /Thursday, October 1, Moses Rivera/ });
    expect(within(day).getByRole('link', { name: '9 Move Out Ln' }).getAttribute('href')).toBe('/inspections/insp-9');
    expect(within(day).getByText('Move-out')).toBeTruthy();
    expect(within(day).getByText('Assigned to Amy Wilson · reassign in Jobber')).toBeTruthy();
    // Ten minutes from the first property, and an hour there.
    expect(within(day).getByText('9:40 AM – 10:40 AM')).toBeTruthy();
    expect(screen.getByText('1 move-out to check')).toBeTruthy();
  });

  /** A blocked stop is a tenancy nobody would inspect; the API refuses too, and the button says so first. */
  it('will not publish while a visit needs attention', () => {
    mount({
      stops: [stop('s1'), stop('s2', { status: 'BLOCKED', blockedCode: 'NOT_PLACED', blockedMessage: 'No day has room.' })],
    });

    expect((screen.getByRole('button', { name: 'Publish' }) as HTMLButtonElement).disabled).toBe(true);
  });

  /** The office (2026-09-18): a visit waiting for its unit has a day, but publishing waits for the unit. */
  it('counts a visit still without its unit as needing attention, and will not publish', () => {
    mount({ stops: [stop('s1'), stop('s2', { unitResolution: 'UNRESOLVED' })] });

    expect(screen.getByRole('tab', { name: 'Needs attention (1)' })).toBeTruthy();
    expect((screen.getByRole('button', { name: 'Publish' }) as HTMLButtonElement).disabled).toBe(true);
  });

  /** A day starts from home; its driving between the properties is shown apart from the drive from home. */
  it('shows the drive from home and when to leave, apart from the driving between properties', () => {
    mount({ day: { ...DAY, originKind: 'HOME', homeDriveSeconds: 35 * 60, homeDriveMeters: 42_000 } });

    const day = screen.getByRole('region', { name: /Thursday, October 1, Moses Rivera/ });
    expect(within(day).getByText('35 min · 42 km · leave 8:25 AM')).toBeTruthy();
    expect(within(day).getByText('35 min from home')).toBeTruthy();
    expect(within(day).getByText(/20 min between properties/)).toBeTruthy();
    expect(within(day).getByText(/the drive from home is shown apart/)).toBeTruthy();
  });

  /** A plan built before days started from home, or for a technician with no home on file. */
  it('says when a day was built without the technician’s home', () => {
    mount();

    const day = screen.getByRole('region', { name: /Thursday, October 1, Moses Rivera/ });
    expect(within(day).getByText('not used')).toBeTruthy();
    expect(within(day).getByText(/Rebuild the plan to route days from home/)).toBeTruthy();
  });

  /** The office asked to see a planned visit the way Jobber shows one (2026-09-16). */
  it('opens a visit’s details from its place in the day', async () => {
    mount();

    fireEvent.click(screen.getByRole('button', { name: 'Details of stop 2, 2 Any St' }));

    const dialog = await screen.findByRole('dialog');
    expect(within(dialog).getByRole('heading', { name: 's2 Any St' })).toBeTruthy();
    expect(within(dialog).getByText('s2 Any St - Zone 1 - Q4 2026 Tenant Benefit Package')).toBeTruthy();
    // The Details, word for word as Jobber will get them.
    expect(within(dialog).getByText(/Instruction for completion/)).toBeTruthy();
    expect(within(dialog).getByText('9:40 AM – 10:25 AM')).toBeTruthy();
    expect(within(dialog).getByText('10 min from stop 1')).toBeTruthy();
    expect(within(dialog).getByText('Tenant of s2')).toBeTruthy();
    expect(within(dialog).getByText('20x25x1 · Hallway ceiling')).toBeTruthy();
    expect(within(dialog).getByText('Booked once the plan is published')).toBeTruthy();
  });

  it('shows the first visit’s drive from home, with when to leave', async () => {
    mount({ day: { ...DAY, originKind: 'HOME', homeDriveSeconds: 35 * 60, homeDriveMeters: 42_000 } });

    fireEvent.click(screen.getByRole('button', { name: 'Details of stop 1, 1 Any St' }));

    const dialog = await screen.findByRole('dialog');
    expect(within(dialog).getByText('35 min from home · 42 km · leave 8:25 AM')).toBeTruthy();
  });

  /** The office edits a draft visit where it reads it (2026-09-16): each value is its own control. */
  it('lets a coordinator change a draft visit’s values in its window, and nothing of a published plan', async () => {
    mount();
    fireEvent.click(screen.getByRole('button', { name: 'Details of stop 2, 2 Any St' }));
    const dialog = await screen.findByRole('dialog');
    for (const value of ['the date', 'the technician', 'the time on site', 'the kind of visit', 'the title', 'the Details'])
      expect(within(dialog).getByRole('button', { name: new RegExp(`Change ${value}`) })).toBeTruthy();
    fireEvent.keyDown(dialog, { key: 'Escape' });

    mount({ plans: [{ ...PLAN, status: 'PUBLISHED' }] });
    fireEvent.click(screen.getAllByRole('button', { name: 'Details of stop 2, 2 Any St' }).at(-1)!);
    const published = (await screen.findAllByRole('dialog')).at(-1)!;
    expect(within(published).queryByRole('button', { name: /Change the date/ })).toBeNull();
  });

  it('opens a visit’s details from the visits table', async () => {
    url.state = { quarter: '2026-4', tab: 'visits', day: '' };
    mount();

    fireEvent.click(screen.getByRole('button', { name: 'Details of the visit at s3 Any St' }));

    const dialog = await screen.findByRole('dialog');
    expect(within(dialog).getByRole('heading', { name: 's3 Any St' })).toBeTruthy();
  });

  /** The office's rules (2026-09-16): a zone each a week, moving weekly; Mondays kept for reschedules. */
  it('shows the crew, who has which zone each week, and the Mondays kept for reschedules', () => {
    mount();

    expect(screen.getByText('Moses Rivera, Kevin Grant, Emanuel Hall · a zone each, moving weekly')).toBeTruthy();
    // Four zones and three people: the zone nobody has this week waits its turn.
    expect(screen.getByText('Zone 1 Moses · Zone 2 Kevin · Zone 3 Emanuel · Zone 4 no one')).toBeTruthy();
    // Too far for a day's drive, so a trip -- planned when the quarter is rebuilt.
    expect(screen.getByText('Zone 5: a trip for whoever lives nearest, planned at the next Rebuild')).toBeTruthy();
    expect(screen.getByText('kept free for rescheduled visits from week 2')).toBeTruthy();
    expect(screen.getByText(/1 HVAC · Zone 1/)).toBeTruthy();
  });

  it('publishes a draft whose visits are all placed', () => {
    mount();

    expect((screen.getByRole('button', { name: 'Publish' }) as HTMLButtonElement).disabled).toBe(false);
  });
});
