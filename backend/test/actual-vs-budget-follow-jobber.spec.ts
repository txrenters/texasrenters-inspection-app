import {
  followJobber,
  planFollowJobber,
  QUIET_MS,
  visitDays,
  type FollowRow,
  type FollowVisit,
} from '../src/admin/actual-vs-budget-follow-jobber';

/**
 * A row the office typed for a job follows the job when Jobber moves it
 * (2026-11-23: Amy's Monday held three of Moses's jobs, typed on Friday while
 * Jobber had them on her for 23 minutes, and one he does on Tuesday -- nine
 * visits on her day where Jobber had five, and those jobs budgeted twice).
 */

// Sunday afternoon: Monday's rows are tomorrow's.
const NOW = new Date('2026-11-22T21:00:00.000Z');
const LONG_AGO = new Date(NOW.getTime() - 2 * 60 * 60_000);

const row = (id: string, technicianId: string, day: string, jobNumber: string, cells: FollowRow['cells'] = {}, updatedAt = LONG_AGO): FollowRow => ({
  id,
  technicianId,
  day,
  jobNumber,
  updatedAt,
  cells,
});
const visit = (jobNumber: string, technicianIds: string[], days: string[], inspection: FollowVisit['inspection'] = null): FollowVisit => ({
  jobberVisitId: `visit-${jobNumber}-${days[0]}`,
  jobNumber,
  days,
  technicianIds,
  inspection,
});
const plan = (rows: FollowRow[], visits: FollowVisit[], ruledOut?: Set<string>) => planFollowJobber({ rows, visits, ruledOut, now: NOW });

describe('a row the office typed for a job, where Jobber has the job now', () => {
  it("goes into the inspection's row when Jobber has the job on another technician's same day -- that row's own cells stand", () => {
    const typed = row('amy-row', 'amy', '2026-11-23', '1001', { driveTime: '15–25 min', timeBudgeted: '30 mins', estimatedBudgetCents: 7899, notes: 'gate code at office' });
    const { actions, left } = plan(
      [typed],
      [visit('1001', ['moses'], ['2026-11-23'], { id: 'insp-1001', day: '2026-11-23', technicianId: 'moses', entryId: 'moses-entry', cells: { driveTime: '10–15 min', timeBudgeted: '30 mins' } })],
    );
    expect(left).toEqual([]);
    expect(actions).toEqual([
      {
        kind: 'fold',
        row: typed,
        into: { entryId: 'moses-entry', inspectionId: 'insp-1001', technicianId: 'moses', day: '2026-11-23' },
        // Only what Moses's row has nothing of: his drive time stays his.
        fill: { estimatedBudgetCents: 7899, notes: 'gate code at office' },
      },
    ]);
  });

  it('goes to the day and technician Jobber moved the inspection to, onto a row with nothing typed yet', () => {
    const typed = row('amy-row', 'amy', '2026-11-23', '#1002', { timeBudgeted: '20 mins', estimatedBudgetCents: 2500 });
    const { actions } = plan([typed], [visit('1002', ['moses'], ['2026-11-24'], { id: 'insp-1002', day: '2026-11-24', technicianId: 'moses', entryId: null, cells: {} })]);
    expect(actions).toEqual([
      {
        kind: 'fold',
        row: typed,
        into: { entryId: null, inspectionId: 'insp-1002', technicianId: 'moses', day: '2026-11-24' },
        fill: { timeBudgeted: '20 mins', estimatedBudgetCents: 2500 },
      },
    ]);
  });

  it('moves to the technician and day Jobber has a repair on, when it is no inspection', () => {
    const typed = row('kevin-row', 'kevin', '2026-11-23', '1003', { driveTime: 'Start', estimatedBudgetCents: 69999 });
    const { actions } = plan([typed], [visit('1003', ['emanuel'], ['2026-11-25'])]);
    expect(actions).toEqual([{ kind: 'move', row: typed, technicianId: 'emanuel', day: '2026-11-25' }]);
  });

  it("fills the row the office already has for the job where Jobber has it, rather than making a second", () => {
    const stray = row('stray', 'amy', '2026-11-23', '1004', { timeBudgeted: '2 hrs', notes: 'bring ladder' });
    const there = row('there', 'thomas', '2026-11-24', '1004', { timeBudgeted: '3 hrs' });
    const { actions } = plan([stray, there], [visit('1004', ['thomas'], ['2026-11-23', '2026-11-24'])]);
    expect(actions).toEqual([{ kind: 'fold', row: stray, into: { entryId: 'there', inspectionId: null, technicianId: 'thomas', day: '2026-11-24' }, fill: { notes: 'bring ladder' } }]);
  });

  it('two rows for one job going to the same place: the first moves, the second fills it', () => {
    const first = row('a', 'amy', '2026-11-23', '1005', { driveTime: '5–10 min' });
    const second = row('b', 'kevin', '2026-11-23', '1005', { driveTime: '20 min', notes: 'second' });
    const { actions } = plan([first, second], [visit('1005', ['moses'], ['2026-11-24'])]);
    expect(actions).toEqual([
      { kind: 'move', row: first, technicianId: 'moses', day: '2026-11-24' },
      { kind: 'fold', row: second, into: { entryId: 'a', inspectionId: null, technicianId: 'moses', day: '2026-11-24' }, fill: { notes: 'second' } },
    ]);
  });
});

describe('a row that stays where it was typed', () => {
  it('when Jobber has the job there -- on any day of a visit that runs over two', () => {
    const { actions, left } = plan(
      [row('first-day', 'thomas', '2026-11-23', '1006'), row('second-day', 'thomas', '2026-11-24', '1006')],
      [visit('1006', ['thomas'], ['2026-11-23', '2026-11-24'])],
    );
    expect(actions).toEqual([]);
    expect(left).toEqual([]);
  });

  it("when Jobber's visit of the job is there, though the inspection it was imported into sits on another day", () => {
    // The job's inspection was walked on 11/18; Jobber has a second visit of it on Moses's 11/23, and the office's row.
    const { actions } = plan(
      [row('return-visit', 'moses', '2026-11-23', '1007', { timeBudgeted: '30 mins' })],
      [visit('1007', ['moses'], ['2026-11-23'], { id: 'insp-1007', day: '2026-11-18', technicianId: 'kevin', entryId: 'kevin-entry', cells: {} })],
    );
    expect(actions).toEqual([]);
  });

  it('when Jobber has no visit of the job in its window, or the row has no Job#', () => {
    const { actions, left } = plan([row('no-job', 'amy', '2026-11-23', ''), row('unknown', 'amy', '2026-11-23', '1008')], []);
    expect(actions).toEqual([]);
    expect(left).toEqual([]);
  });

  it.each([
    ['arrival', { arrival: '09:15' }],
    ['work complete: no', { workComplete: false }],
    ['a reschedule', { rescheduleRequired: true, rescheduleOn: '2026-11-24' }],
    ['labor', { laborCents: 12000 }],
    ['an invoice', { invoiceNumber: 'INV-1' }],
  ])('when it records what happened that day (%s): the day\'s history, not a plan', (_what, cells) => {
    const typed = row('done', 'amy', '2026-11-23', '1009', { timeBudgeted: '1 hr', ...cells });
    const { actions, left } = plan([typed], [visit('1009', ['moses'], ['2026-11-24'])]);
    expect(actions).toEqual([]);
    expect(left).toEqual([{ row: typed, why: 'HAS_OUTCOME' }]);
  });

  it(`when the office changed it in the last ${QUIET_MS / 60_000} minutes -- the next run looks again`, () => {
    const typed = row('fresh', 'amy', '2026-11-23', '1010', {}, new Date(NOW.getTime() - QUIET_MS + 60_000));
    expect(plan([typed], [visit('1010', ['moses'], ['2026-11-23'])]).left).toEqual([{ row: typed, why: 'JUST_CHANGED' }]);
    const settled = { ...typed, updatedAt: new Date(NOW.getTime() - QUIET_MS) };
    expect(plan([settled], [visit('1010', ['moses'], ['2026-11-23'])]).actions).toHaveLength(1);
  });

  it('when there is no telling where it goes: several visits of the job, a visit ruled out in the import queue, no technician of ours or two', () => {
    const several = row('several', 'amy', '2026-11-23', '1011');
    const ruled = row('ruled', 'amy', '2026-11-23', '1012');
    const nobody = row('nobody', 'amy', '2026-11-23', '1013');
    const two = row('two', 'amy', '2026-11-23', '1014');
    const { actions, left } = plan(
      [several, ruled, nobody, two],
      [
        visit('1011', ['moses'], ['2026-11-24']),
        visit('1011', ['moses'], ['2026-11-25']),
        visit('1012', ['moses'], ['2026-11-24']),
        visit('1013', [], ['2026-11-24']),
        visit('1014', ['moses', 'kevin'], ['2026-11-24']),
      ],
      new Set(['1012']),
    );
    expect(actions).toEqual([]);
    expect(left.map((entry) => [entry.row.id, entry.why])).toEqual([
      ['nobody', 'NOT_ONE_TECHNICIAN'],
      ['ruled', 'RULED_OUT_IN_JOBBER'],
      ['several', 'SEVERAL_VISITS'],
      ['two', 'NOT_ONE_TECHNICIAN'],
    ]);
  });
});

describe("a Jobber visit's days, in Texas", () => {
  it('an all-day visit is its one day; one that ends two days later is three', () => {
    expect(visitDays('2026-11-23T06:00:00Z', '2026-11-24T05:59:59Z')).toEqual(['2026-11-23']);
    expect(visitDays('2026-11-23T06:00:00Z', '2026-11-26T05:59:59Z')).toEqual(['2026-11-23', '2026-11-24', '2026-11-25']);
    expect(visitDays('2026-11-23T15:00:00Z', null)).toEqual(['2026-11-23']);
  });

  it('a visit booked to run for months counts only its first day', () => {
    expect(visitDays('2026-11-23T06:00:00Z', '2027-03-01T05:59:59Z')).toEqual(['2026-11-23']);
  });
});

// ── After a run of the Jobber sync, against the console's own copies ──

const ORG = '00000000-0000-4000-8000-000000000001';
const SINCE = new Date(NOW.getTime() - 5 * 60_000);

interface Entry {
  id: string;
  organizationId: string;
  technicianId: string;
  inspectionId: string | null;
  day: Date;
  jobNumber: string | null;
  updatedAt: Date;
  [field: string]: unknown;
}

function fakeDatabase(input: {
  entries: Partial<Entry>[];
  stored: { jobberVisitId: string; status: string; inspectionId?: string | null; lastAttemptAt: Date | null; payload: unknown }[];
  technicians: { id: string; email: string }[];
  inspections?: { id: string; scheduledAt: Date; technicianId: string | null }[];
}) {
  const entries: Entry[] = input.entries.map((entry, index) => ({
    id: `entry-${index}`,
    organizationId: ORG,
    technicianId: 'amy',
    inspectionId: null,
    day: new Date('2026-11-23T00:00:00.000Z'),
    jobNumber: null,
    updatedAt: LONG_AGO,
    ...entry,
  }));
  const audits: { action: string; entityId: string; metadata: Record<string, unknown> }[] = [];
  const excel: Record<string, unknown>[] = [];
  const matches = (entry: Entry, where: Record<string, unknown>) =>
    Object.entries(where).every(([field, wanted]) => {
      const value = entry[field];
      if (wanted && typeof wanted === 'object' && !(wanted instanceof Date)) {
        const test = wanted as { not?: unknown; in?: unknown[]; gte?: Date; lte?: Date };
        if ('not' in test) return value !== test.not;
        if (test.in) return test.in.includes(value);
        return (!test.gte || (value as Date) >= test.gte) && (!test.lte || (value as Date) <= test.lte);
      }
      return wanted instanceof Date ? (value as Date)?.getTime() === wanted.getTime() : value === wanted;
    });
  const db = {
    entries,
    audits,
    excel,
    revenueLogEntry: {
      findMany: async ({ where }: { where: Record<string, unknown> }) => entries.filter((entry) => matches(entry, where)).map((entry) => ({ ...entry })),
      findFirst: async ({ where }: { where: Record<string, unknown> }) => {
        const found = entries.find((entry) => matches(entry, where));
        return found ? { ...found } : null;
      },
      updateMany: async ({ where, data }: { where: Record<string, unknown>; data: Record<string, unknown> }) => {
        const found = entries.filter((entry) => matches(entry, where));
        for (const entry of found) Object.assign(entry, data, { updatedAt: NOW });
        return { count: found.length };
      },
      update: async ({ where, data }: { where: { id: string }; data: Record<string, unknown> }) =>
        Object.assign(entries.find((entry) => entry.id === where.id)!, data, { updatedAt: NOW }),
      delete: async ({ where }: { where: { id: string } }) => entries.splice(entries.findIndex((entry) => entry.id === where.id), 1)[0],
      create: async ({ data }: { data: Partial<Entry> }) => {
        const entry = { id: `entry-${entries.length}-new`, updatedAt: NOW, jobNumber: null, ...data } as Entry;
        entries.push(entry);
        return { id: entry.id };
      },
    },
    $queryRaw: async () => input.stored,
    userProfile: { findMany: async () => input.technicians },
    inspection: {
      findMany: async ({ where }: { where: { id: { in: string[] } } }) =>
        (input.inspections ?? [])
          .filter((inspection) => where.id.in.includes(inspection.id))
          .map((inspection) => ({ id: inspection.id, scheduledAt: inspection.scheduledAt, assignments: inspection.technicianId ? [{ technicianId: inspection.technicianId }] : [] })),
    },
    auditLog: {
      create: async ({ data }: { data: { action: string; entityId: string; metadata: Record<string, unknown> } }) => {
        audits.push(data);
        return data;
      },
    },
    excelSync: {
      updateMany: async ({ data }: { data: Record<string, unknown> }) => {
        excel.push(data);
        return { count: 1 };
      },
    },
  };
  return Object.assign(db, { $transaction: async <T>(work: (tx: unknown) => Promise<T>) => work(db) });
}

const payload = (jobNumber: string, email: string | null, startAt: string, endAt: string) => ({
  id: `visit-${jobNumber}`,
  startAt,
  endAt,
  allDay: true,
  job: { id: `job-${jobNumber}`, jobNumber },
  assignedUsers: { nodes: email ? [{ id: `user-${email}`, email: { raw: email }, name: { full: email } }] : [] },
});
const MONDAY = ['2026-11-23T06:00:00Z', '2026-11-24T05:59:59Z'] as const;
const TUESDAY = ['2026-11-24T06:00:00Z', '2026-11-25T05:59:59Z'] as const;

describe('after a run of the Jobber sync', () => {
  const technicians = [
    { id: 'amy', email: 'amy@example.com' },
    { id: 'moses', email: 'moses@example.com' },
  ];

  it("puts Monday's rows typed on Amy's tab where Jobber has the jobs, records each, and has the Excel sync read every tab", async () => {
    const db = fakeDatabase({
      entries: [
        { id: 'amy-1001', jobNumber: '1001', timeBudgeted: '30 mins', estimatedBudgetCents: 7899 },
        { id: 'amy-1002', jobNumber: '1002', timeBudgeted: '20 mins', estimatedBudgetCents: 2500 },
        { id: 'amy-own', jobNumber: '1003', timeBudgeted: '1 hr' },
        { id: 'moses-1001', technicianId: 'moses', inspectionId: 'insp-1001', jobNumber: null, timeBudgeted: '30 mins', estimatedBudgetCents: 7899 },
      ],
      stored: [
        { jobberVisitId: 'v1001', status: 'IMPORTED', inspectionId: 'insp-1001', lastAttemptAt: NOW, payload: payload('1001', 'MOSES@example.com', ...MONDAY) },
        { jobberVisitId: 'v1002', status: 'IMPORTED', inspectionId: 'insp-1002', lastAttemptAt: NOW, payload: payload('1002', 'moses@example.com', ...TUESDAY) },
        { jobberVisitId: 'v1003', status: 'SKIPPED_NOT_SYNCED', lastAttemptAt: NOW, payload: payload('1003', 'amy@example.com', ...MONDAY) },
        // Gone from Jobber: the run did not read it again.
        { jobberVisitId: 'v1003-old', status: 'SKIPPED_NOT_SYNCED', lastAttemptAt: new Date('2026-11-20T00:00:00Z'), payload: payload('1003', 'moses@example.com', ...TUESDAY) },
      ],
      technicians,
      inspections: [
        { id: 'insp-1001', scheduledAt: new Date('2026-11-23T00:00:00Z'), technicianId: 'moses' },
        { id: 'insp-1002', scheduledAt: new Date('2026-11-24T00:00:00Z'), technicianId: 'moses' },
      ],
    });

    const followed = await followJobber(db as never, ORG, { since: SINCE, to: '2027-01-21' }, NOW);

    expect(followed).toEqual({ moved: 0, folded: 2, left: 0, failed: 0 });
    // Amy's day holds only her own job; Moses's rows hold what was typed, nothing typed twice.
    expect(db.entries.filter((entry) => entry.technicianId === 'amy').map((entry) => entry.id)).toEqual(['amy-own']);
    expect(db.entries.find((entry) => entry.id === 'moses-1001')).toMatchObject({ timeBudgeted: '30 mins', estimatedBudgetCents: 7899 });
    expect(db.entries.find((entry) => entry.inspectionId === 'insp-1002')).toMatchObject({
      technicianId: 'moses',
      day: new Date('2026-11-24T00:00:00Z'),
      timeBudgeted: '20 mins',
      estimatedBudgetCents: 2500,
    });
    // Each row on the record as it was, and what it filled.
    const followedRecords = db.audits.filter((audit) => audit.action === 'REVENUE_LOG_ROW_FOLLOWED_JOBBER');
    expect(followedRecords.map((audit) => audit.entityId).sort()).toEqual(['amy-1001', 'amy-1002']);
    expect(followedRecords.find((audit) => audit.entityId === 'amy-1002')!.metadata).toMatchObject({
      jobNumber: '1002',
      from: { technicianId: 'amy', day: '2026-11-23' },
      to: { technicianId: 'moses', day: '2026-11-24' },
      filled: ['timeBudgeted', 'estimatedBudgetCents'],
      row: expect.objectContaining({ id: 'amy-1002', timeBudgeted: '20 mins' }),
    });
    expect(db.audits.filter((audit) => audit.action === 'REVENUE_LOG_ROW_ADDED').map((audit) => audit.metadata.followedFrom)).toEqual(['amy-1002']);
    expect(db.excel).toEqual([{ fileTag: null, dirtyAt: NOW }]);
  });

  it('moves a repair row to the technician and day Jobber moved the repair to', async () => {
    const db = fakeDatabase({
      entries: [{ id: 'repair', jobNumber: '#1003', driveTime: 'Start' }],
      stored: [{ jobberVisitId: 'v1003', status: 'SKIPPED_NOT_SYNCED', lastAttemptAt: NOW, payload: payload('1003', 'moses@example.com', ...TUESDAY) }],
      technicians,
    });
    expect(await followJobber(db as never, ORG, { since: SINCE, to: '2027-01-21' }, NOW)).toMatchObject({ moved: 1 });
    expect(db.entries).toEqual([expect.objectContaining({ id: 'repair', technicianId: 'moses', day: new Date('2026-11-24T00:00:00Z'), driveTime: 'Start' })]);
  });

  it('changes nothing, and leaves Excel alone, when every row is where Jobber has its job or cannot be told', async () => {
    const db = fakeDatabase({
      entries: [
        { id: 'right', jobNumber: '1003' },
        { id: 'ruled', jobNumber: '1004' },
      ],
      stored: [
        { jobberVisitId: 'v1003', status: 'SKIPPED_NOT_SYNCED', lastAttemptAt: NOW, payload: payload('1003', 'amy@example.com', ...MONDAY) },
        // Ruled out in the import queue: never read again, so where Jobber has it is not known.
        { jobberVisitId: 'v1004', status: 'IGNORED', lastAttemptAt: new Date('2026-10-15T00:00:00Z'), payload: payload('1004', 'moses@example.com', ...MONDAY) },
        { jobberVisitId: 'v1004-b', status: 'SKIPPED_NOT_SYNCED', lastAttemptAt: NOW, payload: payload('1004', 'moses@example.com', ...TUESDAY) },
      ],
      technicians,
    });
    expect(await followJobber(db as never, ORG, { since: SINCE, to: '2027-01-21' }, NOW)).toEqual({ moved: 0, folded: 0, left: 1, failed: 0 });
    expect(db.entries.map((entry) => [entry.id, entry.technicianId])).toEqual([
      ['right', 'amy'],
      ['ruled', 'amy'],
    ]);
    expect(db.audits).toEqual([]);
    expect(db.excel).toEqual([]);
  });

  it("leaves today's rows and those of days gone by where they were typed, whatever Jobber has since -- the days' record", async () => {
    // A repair worked over several days, a row for each, and Jobber's one visit of it moved along to Tuesday.
    const db = fakeDatabase({
      entries: [
        { id: 'friday', jobNumber: '1003', day: new Date('2026-11-20T00:00:00.000Z'), driveTime: '40–55 min', timeBudgeted: '3 hrs' },
        { id: 'today', jobNumber: '1003', day: new Date('2026-11-22T00:00:00.000Z'), timeBudgeted: '3 hrs' },
        { id: 'monday', jobNumber: '1003', day: new Date('2026-11-23T00:00:00.000Z'), timeBudgeted: '2 hrs' },
      ],
      stored: [{ jobberVisitId: 'v1003', status: 'SKIPPED_NOT_SYNCED', lastAttemptAt: NOW, payload: payload('1003', 'amy@example.com', ...TUESDAY) }],
      technicians,
    });
    expect(await followJobber(db as never, ORG, { since: SINCE, to: '2027-01-21' }, NOW)).toMatchObject({ moved: 1, folded: 0 });
    expect(db.entries.map((entry) => [entry.id, entry.day.toISOString().slice(0, 10)])).toEqual([
      ['friday', '2026-11-20'],
      ['today', '2026-11-22'],
      // Only the day still to come goes to Tuesday.
      ['monday', '2026-11-24'],
    ]);
  });

  it('leaves a row the office changed after it was read: the next run looks again', async () => {
    const db = fakeDatabase({
      entries: [{ id: 'repair', jobNumber: '1003' }],
      stored: [{ jobberVisitId: 'v1003', status: 'SKIPPED_NOT_SYNCED', lastAttemptAt: NOW, payload: payload('1003', 'moses@example.com', ...TUESDAY) }],
      technicians,
    });
    // Saved by the office between the read and the move.
    const read = db.revenueLogEntry.findMany;
    db.revenueLogEntry.findMany = async (query) => {
      const found = await read(query);
      db.entries[0]!.updatedAt = new Date(NOW.getTime() - 1_000);
      return found;
    };
    expect(await followJobber(db as never, ORG, { since: SINCE, to: '2027-01-21' }, NOW)).toMatchObject({ moved: 0, failed: 0 });
    expect(db.entries[0]).toMatchObject({ technicianId: 'amy' });
    expect(db.excel).toEqual([]);
  });
});
