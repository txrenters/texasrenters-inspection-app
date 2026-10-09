import {
  compareJobberDay,
  type DayInput,
  type DayInspection,
  type StoredJobberVisit,
} from '../src/integrations/jobber/jobber-day';

/**
 * "Today against Jobber" (console-development, 2026-10-09): the console's
 * inspections beside the Jobber visits the sync last stored, for one Texas day.
 * Invented streets and people throughout.
 */

const DATE = '2026-10-09';
// 9:00 AM and 1:00 PM in Texas (CDT, UTC-5) on the day.
const NINE = '2026-10-09T14:00:00Z';
const ONE_PM = '2026-10-09T18:00:00Z';
const TWO_THIRTY = '2026-10-09T19:30:00Z';

const MOSES = { id: 't-moses', displayName: 'Moses R.', email: 'moses@example.test' };
const AMY = { id: 't-amy', displayName: 'Amy W.', email: 'amy@example.test' };

const lastSyncStartedAt = new Date('2026-10-09T13:55:00Z');
const seen = new Date('2026-10-09T13:56:00Z');

function inspection(over: Partial<DayInspection> = {}): DayInspection {
  return {
    id: 'insp-1',
    status: 'SCHEDULED',
    inspectionType: 'OCCUPIED',
    scheduledStartAt: new Date(NINE),
    jobberVisitId: 'v-1',
    property: '1204 Cedar Hollow Dr',
    technician: MOSES,
    waitingKinds: [],
    ...over,
  };
}

function visit(
  over: Omit<Partial<StoredJobberVisit>, 'payload'> & {
    payload?: Partial<NonNullable<StoredJobberVisit['payload']>> | null;
  } = {},
): StoredJobberVisit {
  const { payload, ...rest } = over;
  return {
    jobberVisitId: 'v-1',
    status: 'IMPORTED',
    failureMessage: null,
    inspectionId: 'insp-1',
    lastAttemptAt: seen,
    ...rest,
    payload:
      payload === null
        ? null
        : {
            id: rest.jobberVisitId ?? 'v-1',
            title: 'Occupied Inspection',
            startAt: NINE,
            endAt: null,
            completedAt: null,
            allDay: false,
            assignedUsers: { nodes: [{ id: 'j-moses', email: { raw: 'Moses@Example.test' }, name: { full: 'Moses Rodriguez' } }] },
            property: { id: 'jp-1', address: { street1: '1204 Cedar Hollow Dr' } },
            ...payload,
          },
  };
}

function day(over: Partial<DayInput> = {}) {
  return compareJobberDay({
    date: DATE,
    inspections: [inspection()],
    visits: [visit()],
    linkedElsewhere: new Map(),
    technicians: [MOSES, AMY],
    connection: { connected: true, lastSyncStartedAt, lastSyncCompletedAt: new Date('2026-10-09T13:57:00Z') },
    pushesEnabled: true,
    ...over,
  });
}

describe('a day against Jobber', () => {
  it("says whether the Schedule's buttons that send to Jobber are on: off unless asked", () => {
    expect(day().actionsEnabled).toBe(false);
    expect(day({ actionsEnabled: true }).actionsEnabled).toBe(true);
  });

  it('matches when the day, the time and the person agree (email case aside)', () => {
    const result = day();

    expect(result.rows).toHaveLength(1);
    expect(result.rows[0]).toMatchObject({ state: 'MATCHES', differences: [] });
    expect(result.technicians[0]).toMatchObject({ technicianId: 't-moses', here: 1, inJobber: 1, differences: 0 });
  });

  it('says the times when they differ, in Texas time', () => {
    const result = day({
      inspections: [inspection({ scheduledStartAt: new Date(ONE_PM) })],
      visits: [visit({ payload: { startAt: TWO_THIRTY } })],
    });

    expect(result.rows[0].state).toBe('TIME_DIFFERS');
    expect(result.rows[0].differences).toEqual(['Here 1:00 PM, Jobber 2:30 PM']);
  });

  it('does not call a whole-day visit a different time', () => {
    const result = day({ visits: [visit({ payload: { startAt: TWO_THIRTY, allDay: true } })] });

    expect(result.rows[0].state).toBe('MATCHES');
  });

  it('names a different person, but reads nobody named in Jobber as no answer', () => {
    const other = day({ inspections: [inspection({ technician: AMY })] });
    expect(other.rows[0].state).toBe('TECHNICIAN_DIFFERS');
    expect(other.rows[0].differences[0]).toBe('Jobber has Moses R., here Amy W.');

    const nobody = day({ visits: [visit({ payload: { assignedUsers: { nodes: [] } } })] });
    expect(nobody.rows[0].state).toBe('MATCHES');
  });

  it('flags a visit Jobber puts on another day, by the Texas day of its start', () => {
    // 8:30 PM Texas on the 9th is the 10th in UTC: not a different day.
    const evening = day({ visits: [visit({ payload: { startAt: '2026-10-10T01:30:00Z', allDay: true } })] });
    expect(evening.rows[0].state).toBe('MATCHES');

    const moved = day({ visits: [visit({ payload: { startAt: '2026-10-12T14:00:00Z' } })] });
    expect(moved.rows[0].state).toBe('DAY_DIFFERS');
    expect(moved.rows[0].differences[0]).toBe('Jobber has it on Mon, Oct 12');
  });

  it('puts the most urgent first: cancelled here but open in Jobber', () => {
    const result = day({
      inspections: [
        inspection({ id: 'insp-2', jobberVisitId: 'v-2', property: '88 Lantern Bay Ct' }),
        inspection({ status: 'CANCELLED' }),
      ],
      visits: [visit(), visit({ jobberVisitId: 'v-2', inspectionId: 'insp-2' })],
    });

    expect(result.rows.map((row) => row.state)).toEqual(['CANCELLED_HERE', 'MATCHES']);
    // A cancelled inspection is not counted as work here.
    expect(result.technicians[0].here).toBe(1);
  });

  it('leaves out a cancelled inspection that Jobber has closed or dropped too', () => {
    expect(day({ inspections: [inspection({ status: 'CANCELLED' })], visits: [visit({ payload: { completedAt: ONE_PM } })] }).rows).toEqual([]);
    expect(day({ inspections: [inspection({ status: 'CANCELLED', jobberVisitId: null })], visits: [] }).rows).toEqual([]);
  });

  it('tells done-here-open-there from done-there-open-here', () => {
    expect(day({ inspections: [inspection({ status: 'TECHNICIAN_SUBMITTED' })] }).rows[0].state).toBe('DONE_HERE');
    expect(day({ visits: [visit({ payload: { completedAt: ONE_PM } })] }).rows[0].state).toBe('DONE_IN_JOBBER');
  });

  it('says when the last full sync no longer saw a linked visit', () => {
    const result = day({ visits: [visit({ lastAttemptAt: new Date('2026-10-08T10:00:00Z') })] });

    expect(result.rows[0].state).toBe('UNSEEN');
  });

  it('lists an inspection with no Jobber visit as not booked there', () => {
    const result = day({ inspections: [inspection({ jobberVisitId: null })], visits: [] });

    expect(result.rows[0]).toMatchObject({ state: 'NOT_IN_JOBBER', jobber: null });
    expect(result.technicians[0]).toMatchObject({ here: 1, inJobber: 0 });
  });

  it('shows a Jobber-only visit with the reason it did not become one, under its Jobber person', () => {
    const result = day({
      inspections: [],
      visits: [
        visit({
          jobberVisitId: 'v-9',
          inspectionId: null,
          status: 'UNMATCHED_PROPERTY',
          payload: { assignedUsers: { nodes: [{ id: 'j-amy', email: { raw: 'amy@example.test' }, name: { full: 'Amy Wilson' } }] }, property: { id: 'jp-9', address: { street1: '806 Thistle Row' } } },
        }),
      ],
    });

    expect(result.rows[0]).toMatchObject({
      state: 'ONLY_IN_JOBBER',
      property: '806 Thistle Row',
      technicianId: 't-amy',
      importNote: 'Its Jobber property is not linked to a property here yet',
    });
    expect(result.technicians[0]).toMatchObject({ technicianId: 't-amy', here: 0, inJobber: 1 });
  });

  it('keeps work that is not an inspection apart, so the counts still add up', () => {
    const result = day({
      inspections: [],
      visits: [visit({ jobberVisitId: 'v-7', inspectionId: null, status: 'SKIPPED_NOT_SYNCED', failureMessage: 'Not named as an inspection', payload: { title: 'Pick up Traps' } })],
    });

    expect(result.rows).toEqual([]);
    expect(result.otherWork).toEqual([
      expect.objectContaining({ title: 'Pick up Traps', reason: 'Not named as an inspection', technician: 'Moses R.' }),
    ]);
  });

  it('reads a Jobber visit of the day whose inspection is on another day here', () => {
    const result = day({
      inspections: [],
      visits: [visit({ inspectionId: 'insp-elsewhere' })],
      linkedElsewhere: new Map([['insp-elsewhere', { date: '2026-10-13', status: 'SCHEDULED', property: '17 Willow Crest Way', technicianId: 't-moses' }]]),
    });

    expect(result.rows[0]).toMatchObject({ state: 'DAY_DIFFERS', property: '17 Willow Crest Way', inspectionId: 'insp-elsewhere' });
    expect(result.rows[0].differences[0]).toBe('Here on Tue, Oct 13, Jobber on this day');
  });

  it('marks a row whose change of ours is still waiting to go to Jobber', () => {
    const result = day({ inspections: [inspection({ waitingKinds: ['VISIT_RESCHEDULE'] })] });

    expect(result.rows[0].waitingToSend).toBe(true);
  });
});
