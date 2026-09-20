import { fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { toast } from 'sonner';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

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
// The maps load Google's script; the page around them is what is under test.
vi.mock('@/components/planning/plan-day-map', () => ({ PlanDayMap: () => <div data-testid="plan-day-map" /> }));
vi.mock('@/components/planning/plan-attention-map', () => ({
  PlanAttentionMap: ({ stops, planned }: { stops: { id: string; attention: string | null }[]; planned: { id: string }[] }) => (
    <div data-testid="plan-attention-map">
      {stops.map((stop) => (
        <span key={stop.id}>{`${stop.id}: ${stop.attention}`}</span>
      ))}
      <span>{`planned behind: ${planned.map((stop) => stop.id).join(', ') || 'none'}`}</span>
    </div>
  ),
}));

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
  maxStopsPerDay: 10,
  maxLegMinutes: 20,
  holidays: ['2026-11-26'],
  startsOn: null as string | null,
  crewTechnicianIds: [] as string[],
};

/** Who can be sent out: the crew first, in its order, then everyone else. */
const TECHNICIANS = [
  { id: 'tech-1', displayName: 'Moses Rivera', crewOrder: 1, hasHome: true },
  { id: 'tech-2', displayName: 'Kevin Grant', crewOrder: 2, hasHome: true },
  { id: 'tech-3', displayName: 'Emanuel Hall', crewOrder: 3, hasHome: true },
  { id: 'tech-4', displayName: 'Amy Wilson', crewOrder: null, hasHome: false },
];

const stop = (id: string, overrides: Record<string, unknown> = {}) => ({
  id,
  sequence: Number(id.slice(1)),
  previousSequence: null,
  orderSource: 'PRIOR_QUARTER',
  zone: '1',
  latitude: 29.76,
  longitude: -95.37,
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
  editStop = idle as unknown,
  advice = null as unknown,
  applyAdvice = null as unknown,
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
  hooks.usePlanTechnicians.mockReturnValue({ data: TECHNICIANS, isLoading: false });
  hooks.usePlanningMutations.mockReturnValue({
    build,
    editStop,
    importOfficeDetails: idle,
    setType: idle,
    exclude: idle,
    publish: idle,
    advice: advice ?? idle,
    applyAdvice: applyAdvice ?? idle,
  });
  return render(<PlanningPage />);
}

beforeEach(() => {
  vi.clearAllMocks();
  url.state = { quarter: '2026-4', tab: 'days', day: '' };
  // Saturday 19 September 2026 in Texas: Q4 may start from today to 16 October.
  vi.useFakeTimers({ toFake: ['Date'] });
  vi.setSystemTime(new Date('2026-09-19T15:00:00.000Z'));
});

afterEach(() => {
  vi.useRealTimers();
});

describe('the benefit package plan page', () => {
  it('offers to build a quarter that has no plan yet', () => {
    mount({ plans: [] });

    expect(screen.getByText('No plan for Q4 2026 yet')).toBeTruthy();
    expect(screen.getByRole('button', { name: /Build the Q4 2026 plan/ })).toBeTruthy();
  });

  /**
   * The office (2026-09-19): "before generating ... it should ask for the
   * technicians ... with check box we can select who", and the first day. Nothing
   * else: a form of visit minutes and closed days was confusing (2026-09-16).
   */
  it('asks who goes out and the first day before it builds a quarter, the crew ticked', () => {
    mount({ plans: [] });

    fireEvent.click(screen.getByRole('button', { name: /Build the Q4 2026 plan/ }));

    const dialog = screen.getByRole('dialog', { name: 'Build the Q4 2026 plan' });
    expect(build.mutate).not.toHaveBeenCalled();
    expect(within(dialog).getByRole('checkbox', { name: /Moses Rivera/ }).getAttribute('data-state')).toBe('checked');
    expect(within(dialog).getByRole('checkbox', { name: /Amy Wilson/ }).getAttribute('data-state')).toBe('unchecked');
    // Fifteen days early, on time, or fifteen days late -- and nothing else asked.
    expect(within(dialog).getByRole('radio', { name: /15 days early/ }).getAttribute('checked')).toBeNull();
    expect((within(dialog).getByRole('radio', { name: /On time/ }) as HTMLInputElement).checked).toBe(true);
    expect(within(dialog).getByText(/Sep 16/)).toBeTruthy();
    expect(within(dialog).getByText(/Oct 16/)).toBeTruthy();
    expect(within(dialog).queryByText(/minutes a visit|closed days/i)).toBeNull();

    // Emanuel is off this quarter, and Amy is sent instead.
    fireEvent.click(within(dialog).getByRole('checkbox', { name: /Emanuel Hall/ }));
    fireEvent.click(within(dialog).getByRole('checkbox', { name: /Amy Wilson/ }));
    fireEvent.click(within(dialog).getByRole('button', { name: 'Build for 3 technicians' }));

    expect(build.mutate).toHaveBeenCalledWith(
      { year: 2026, quarter: 4, technicianIds: ['tech-1', 'tech-2', 'tech-4'], startsOn: '2026-10-01' },
      expect.anything(),
    );
  });

  it('will not build for nobody', () => {
    mount({ plans: [] });

    fireEvent.click(screen.getByRole('button', { name: /Build the Q4 2026 plan/ }));
    const dialog = screen.getByRole('dialog');
    for (const name of [/Moses Rivera/, /Kevin Grant/, /Emanuel Hall/]) fireEvent.click(within(dialog).getByRole('checkbox', { name }));

    expect((within(dialog).getByRole('button', { name: 'Build for 0 technicians' }) as HTMLButtonElement).disabled).toBe(true);
  });

  it('rebuilds a draft for the technicians and the first day it was built for, unless changed', () => {
    mount({ plans: [{ ...PLAN, crewTechnicianIds: ['tech-1', 'tech-2'], startsOn: '2026-09-21T00:00:00.000Z' }] });

    fireEvent.click(screen.getByRole('button', { name: 'Rebuild' }));

    const dialog = screen.getByRole('dialog', { name: 'Rebuild Q4 2026' });
    expect(within(dialog).getByRole('checkbox', { name: /Emanuel Hall/ }).getAttribute('data-state')).toBe('unchecked');
    // The day it was built from is kept, beside the three the office picks between.
    expect((within(dialog).getByRole('radio', { name: /As built/ }) as HTMLInputElement).checked).toBe(true);
    fireEvent.click(within(dialog).getByRole('button', { name: 'Rebuild for 2 technicians' }));

    expect(build.mutate).toHaveBeenCalledWith(
      { year: 2026, quarter: 4, technicianIds: ['tech-1', 'tech-2'], startsOn: '2026-09-21' },
      expect.anything(),
    );
    expect(screen.queryByRole('button', { name: 'Lay out days' })).toBeNull();
  });

  /** The office (2026-09-19): "the +-15 days if we will apply the +15 or -15 or on time quarter schedule". */
  it('builds from fifteen days before the quarter when that is chosen', () => {
    mount({ plans: [] });

    fireEvent.click(screen.getByRole('button', { name: /Build the Q4 2026 plan/ }));
    const dialog = screen.getByRole('dialog');
    fireEvent.click(within(dialog).getByRole('radio', { name: /15 days early/ }));
    fireEvent.click(within(dialog).getByRole('button', { name: 'Build for 3 technicians' }));

    expect(build.mutate).toHaveBeenCalledWith(
      { year: 2026, quarter: 4, technicianIds: ['tech-1', 'tech-2', 'tech-3'], startsOn: '2026-09-16' },
      expect.anything(),
    );
  });

  /** A build takes minutes (244 s for Q4 2026); a spinner alone read as a hung page. */
  it('says a build takes a few minutes while it runs, in the toast its result replaces', () => {
    const loading = vi.spyOn(toast, 'loading');
    mount();

    fireEvent.click(screen.getByRole('button', { name: 'Rebuild' }));
    fireEvent.click(within(screen.getByRole('dialog')).getByRole('button', { name: 'Rebuild for 3 technicians' }));

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
    expect(screen.getByText("Oct 1, the quarter's first day")).toBeTruthy();
    // Days of nine, room for the office's own, and no drive over twenty minutes between properties (2026-09-19).
    expect(screen.getByText('Over 10 visits, 6 hr inspecting, or 20 min between properties')).toBeTruthy();
    expect(screen.getByText('9, and up to 10 where the properties are within 5 minutes of each other')).toBeTruthy();
    expect(screen.getByText('never more than 20 min from one to the next; fewer visits where they are further apart')).toBeTruthy();
    // How far the crew's homes may be from a zone is not a limit on a day.
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
            kind: 'MOVE_OUT',
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

  /** The office (2026-09-18): a move-in is on the day of the crew member it is booked for. */
  it('shows a move-in a day is built around, and asks nothing of it while it is still that technician’s', () => {
    mount({
      day: {
        ...DAY,
        onSiteMinutes: 165,
        stops: DAY.stops.map((stop, index) => ({ ...stop, positionInDay: index === 0 ? 1 : index + 2 })),
        anchors: [
          {
            id: 'anchor-2',
            inspectionId: 'insp-10',
            kind: 'MOVE_IN',
            positionInDay: 2,
            onSiteMinutes: 60,
            driveSecondsForecast: 600,
            address: '10 Move In Ct',
            city: 'Katy',
            latitude: 29.705,
            longitude: -95.7,
            assignedTechnician: { id: DAY.technician.id, displayName: DAY.technician.displayName },
            needsReassigning: false,
            scheduledOn: '2026-10-01',
            cancelled: false,
          },
        ],
      },
    });

    const day = screen.getByRole('region', { name: /Thursday, October 1, Moses Rivera/ });
    expect(within(day).getByText('Move-in')).toBeTruthy();
    expect(within(day).getByRole('link', { name: '10 Move In Ct' }).getAttribute('href')).toBe('/inspections/insp-10');
    expect(screen.queryByText(/to check$/)).toBeNull();
  });

  /**
   * The office (2026-09-20): "let's not make the needs attention as blocker for
   * publishing the TBP ... those needs to an attention should be reflected also
   * into the unscheduled appointment".
   */
  it('publishes while visits still need attention, and says where the ones with no day go', () => {
    mount({
      stops: [
        stop('s1'),
        stop('s2', {
          status: 'BLOCKED',
          blockedCode: 'NOT_PLACED',
          blockedMessage: 'No day has room.',
          scheduledOn: null,
          assignedTechnicianId: null,
          assignedTechnician: null,
        }),
      ],
    });

    const publish = screen.getByRole('button', { name: 'Publish' }) as HTMLButtonElement;
    expect(publish.disabled).toBe(false);
    fireEvent.click(publish);
    expect(screen.getByRole('button', { name: /Publish 1 inspections and 1 unscheduled/ })).toBeTruthy();
    expect(screen.getByText(/go to Jobber with no day on them/)).toBeTruthy();
  });

  /** The office (2026-09-18): a visit waiting for its unit has a day, and still needs one chosen. */
  it('counts a visit still without its unit as needing attention', () => {
    mount({ stops: [stop('s1'), stop('s2', { unitResolution: 'UNRESOLVED' })] });

    expect(screen.getByRole('tab', { name: 'Needs attention (1)' })).toBeTruthy();
    expect((screen.getByRole('button', { name: 'Publish' }) as HTMLButtonElement).disabled).toBe(false);
  });

  /**
   * The office (2026-09-18): "there's no function or control to fix it". The
   * unit is chosen right in the list, and a unit another visit in the building
   * already has says so.
   */
  it('chooses the unit of a visit waiting for one where it is listed', async () => {
    url.state = { quarter: '2026-4', tab: 'attention', day: '' };
    const units = [
      { id: 'unit-house', name: 'House', addressLine1: '5009 N Main St' },
      { id: 'unit-half', name: '1/2', addressLine1: '5009 1/2 N Main St' },
    ];
    const chosen = stop('s1', { buildingUnits: units, unitResolution: 'MANUAL', propertywareUnit: units[0] });
    const waiting = stop('s2', { buildingUnits: units, unitResolution: 'UNRESOLVED', propertywareUnit: null });
    const editStop = { mutateAsync: vi.fn().mockResolvedValue({}), isPending: false };
    mount({ stops: [chosen, waiting], editStop });

    fireEvent.click(screen.getByRole('button', { name: /Change the unit of visit 2/ }));
    expect(await screen.findByText('Already chosen for another visit here')).toBeTruthy();
    fireEvent.click(await screen.findByRole('option', { name: /1\/2/ }));

    await waitFor(() => expect(editStop.mutateAsync).toHaveBeenCalledWith({ stopId: 's2', propertywareUnitId: 'unit-half' }));
  });

  /**
   * The office (2026-09-20), on the quarter whose publish had failed: "I should
   * be able to rebuild it". A published quarter still has the visits it could
   * not create, and a rebuild only ever touches those.
   */
  it('offers Rebuild and Publish the rest on a quarter that has been published', () => {
    mount({ plans: [{ ...PLAN, status: 'PUBLISH_FAILED' }] });

    expect(screen.getByRole('button', { name: 'Rebuild' })).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Publish the rest' })).toBeTruthy();
  });

  /**
   * The office (2026-09-20), after publishing a quarter with visits that had no
   * day: "then create an unscheduled also in the console". Jobber lists them;
   * so does this.
   */
  it('lists the visits published to Jobber with no day, and opens one to place it', () => {
    url.state = { quarter: '2026-4', tab: 'unscheduled', day: '' };
    const waiting = stop('s2', {
      status: 'UNSCHEDULED',
      scheduledOn: null,
      positionInDay: null,
      assignedTechnicianId: null,
      assignedTechnician: null,
    });
    mount({ plans: [{ ...PLAN, status: 'PUBLISHED' }], stops: [stop('s1'), waiting] });

    expect(screen.getByRole('tab', { name: 'Unscheduled (1)' })).toBeTruthy();
    expect(screen.getByText(/In Jobber with no day on them/)).toBeTruthy();
    expect(within(screen.getByTestId('plan-attention-map')).getByText('s2: NO_DAY')).toBeTruthy();
  });

  /**
   * The office (2026-09-20), on a quarter whose publish had failed: "opening
   * this dialougue wont let me edit it". A visit with no inspection stays
   * changeable whatever the quarter's state.
   */
  it('still lets a visit with no day be changed after the quarter is published', () => {
    url.state = { quarter: '2026-4', tab: 'visits', day: '' };
    const failed = stop('s2', {
      status: 'FAILED',
      scheduledOn: null,
      positionInDay: null,
      assignedTechnicianId: null,
      assignedTechnician: null,
      blockedMessage: 'This stop has no property or no scheduled day.',
    });
    mount({ plans: [{ ...PLAN, status: 'PUBLISH_FAILED' }], stops: [failed] });

    fireEvent.pointerDown(screen.getByRole('button', { name: 'Change the visit at s2 Any St' }), {
      button: 0,
      pointerId: 1,
      pointerType: 'mouse',
    });
    expect(screen.getByRole('menuitem', { name: /Give it a day and a technician/ })).toBeTruthy();
  });

  /**
   * The office (2026-09-20), beside Jobber's unscheduled appointments and its
   * map: "kaning naka needs attention pwede nato ni ma latag tanan sa map para
   * makita ni sila asa dapita?"
   */
  it('lays every visit needing attention out on a map, the planned ones behind them', () => {
    url.state = { quarter: '2026-4', tab: 'attention', day: '' };
    const noDay = stop('s2', {
      status: 'BLOCKED',
      blockedCode: 'NOT_PLACED',
      blockedMessage: 'No day has room.',
      scheduledOn: null,
      assignedTechnicianId: null,
      assignedTechnician: null,
    });
    const noTechnician = stop('s3', { assignedTechnicianId: null, assignedTechnician: null, status: 'BLOCKED' });
    mount({ stops: [stop('s1'), noDay, noTechnician] });

    const map = screen.getByTestId('plan-attention-map');
    expect(within(map).getByText('s2: NO_DAY')).toBeTruthy();
    expect(within(map).getByText('s3: NO_TECHNICIAN')).toBeTruthy();
    expect(within(map).getByText('planned behind: s1')).toBeTruthy();
  });

  it('says how many visits needing attention have no location to put on the map', () => {
    url.state = { quarter: '2026-4', tab: 'attention', day: '' };
    const nowhere = stop('s2', { status: 'BLOCKED', scheduledOn: null, assignedTechnicianId: null, latitude: null, longitude: null });
    mount({ stops: [stop('s1'), nowhere] });

    expect(screen.getByText(/1 is not on the map: Propertyware has no location for the property\./)).toBeTruthy();
  });

  /**
   * The office (2026-09-20): "can you integrate ai into this also cause I have
   * openai integrated already with the system". What it says, and the moves the
   * rules allowed -- applied only when the office takes them.
   */
  it('shows what AI makes of the quarter, and applies the moves the office takes', async () => {
    const advice = {
      mutate: vi.fn((_planId: string, handlers: { onSuccess: (result: unknown) => void }) =>
        handlers.onSuccess({
          notes: ['Thu 1 Oct mixes four visits in one neighbourhood with one fifteen kilometres north.'],
          proposed: 2,
          moves: [
            {
              stopId: 's3',
              address: '3 Any St',
              fromDate: '2026-10-01',
              toDate: '2026-10-02',
              toTechnicianId: 'tech-2',
              toTechnicianName: 'Kevin Grant',
              savedMinutes: 14,
              why: 'It is next to Kevin’s day.',
            },
          ],
          refused: [{ stopId: 's2', address: '2 Any St', toDate: '2026-10-05', refused: 'It would not shorten the driving.' }],
          savedMinutes: 14,
          provider: 'OPENAI',
          modelId: 'gpt-5.6-terra',
          usage: { inputTokens: 100, outputTokens: 50, totalTokens: 150 },
        }),
      ),
      isPending: false,
    };
    const applyAdvice = { mutate: vi.fn(), isPending: false };
    mount({ advice, applyAdvice });

    fireEvent.click(screen.getByRole('button', { name: 'Ask AI' }));

    expect(await screen.findByText(/mixes four visits in one neighbourhood/)).toBeTruthy();
    expect(screen.getByText(/saves 14 min/)).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: /Apply 1 move/ }));
    expect(applyAdvice.mutate.mock.calls[0][0]).toEqual({
      planId: 'plan-1',
      moves: [{ stopId: 's3', toDate: '2026-10-02', toTechnicianId: 'tech-2' }],
    });
  });

  /**
   * The office (2026-09-20), looking at visits the planner could not place: "how
   * can we resolve this if we can't assign this?" The visit's own window is where
   * a day and a technician are given, and the list now says so.
   */
  it('opens a visit the planner could not place, to give it a day and a technician', async () => {
    url.state = { quarter: '2026-4', tab: 'attention', day: '' };
    const blocked = stop('s1', {
      status: 'BLOCKED',
      blockedCode: 'NOT_PLACED',
      blockedMessage: 'Every crew member’s day in this visit’s month is already full.',
      scheduledOn: null,
      positionInDay: null,
      assignedTechnicianId: null,
      assignedTechnician: null,
    });
    mount({ stops: [blocked] });

    // The menu opens on pointer down, as Radix does it.
    fireEvent.pointerDown(screen.getByRole('button', { name: /Change the visit at s1 Any St/ }), {
      button: 0,
      ctrlKey: false,
      pointerId: 1,
      pointerType: 'mouse',
    });
    fireEvent.click(await screen.findByRole('menuitem', { name: 'Give it a day and a technician…' }));

    const dialog = await screen.findByRole('dialog');
    expect(within(dialog).getByRole('heading', { name: 's1 Any St' })).toBeTruthy();
    // The day and the technician are its own controls in the window.
    expect(within(dialog).getByRole('button', { name: /Change the date/ })).toBeTruthy();
    expect(within(dialog).getByRole('button', { name: /Change the technician/ })).toBeTruthy();
  });

  /** A day starts from home; its driving between the properties is shown apart from the drive from home. */
  it('shows the drive from home and when to leave, apart from the driving between properties', () => {
    mount({ day: { ...DAY, originKind: 'HOME', homeDriveSeconds: 35 * 60, homeDriveMeters: 42_000 } });

    const day = screen.getByRole('region', { name: /Thursday, October 1, Moses Rivera/ });
    expect(within(day).getByText('35 min · 42 km · leave 8:25 AM')).toBeTruthy();
    expect(within(day).getByText('35 min from home')).toBeTruthy();
    expect(within(day).getByText(/^20 min between properties/)).toBeTruthy();
    expect(within(day).getByText(/the drive from home is shown apart/)).toBeTruthy();
  });

  /** The office (2026-09-19): no drive over twenty minutes from one property to the next. */
  it('shows a drive between properties over the limit, and counts its day outside the rules', () => {
    const long = { ...DAY, stops: DAY.stops.map((entry) => (entry.id === 's3' ? { ...entry, driveSecondsForecast: 25 * 60 } : entry)) };
    mount({ day: long });

    const day = screen.getByRole('region', { name: /Thursday, October 1, Moses Rivera/ });
    expect(within(day).getByText('25 min drive · over the 20 min between properties')).toBeTruthy();
    expect(screen.getByRole('navigation', { name: 'Planned technician-days' }).textContent).toContain('a 25 min drive between properties');
    const stat = screen.getByText('Days outside the rules').parentElement!.parentElement!;
    expect(within(stat).getByText('1').className).toContain('text-destructive');
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
  it('lets a coordinator change a draft visit’s values in its window, and nothing of a visit already published', async () => {
    mount();
    fireEvent.click(screen.getByRole('button', { name: 'Details of stop 2, 2 Any St' }));
    const dialog = await screen.findByRole('dialog');
    for (const value of ['the date', 'the technician', 'the time on site', 'the kind of visit', 'the title', 'the Details'])
      expect(within(dialog).getByRole('button', { name: new RegExp(`Change ${value}`) })).toBeTruthy();
    fireEvent.keyDown(dialog, { key: 'Escape' });

    // Its inspection exists: the day is the inspection's now, not the plan's.
    mount({
      plans: [{ ...PLAN, status: 'PUBLISHED' }],
      stops: [stop('s1'), stop('s2', { status: 'PUBLISHED', inspectionId: 'insp-1' }), stop('s3')],
    });
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

    expect(screen.getByText('Moses Rivera, Kevin Grant, Emanuel Hall · the crew on the planning profiles · a zone each, moving weekly')).toBeTruthy();
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
