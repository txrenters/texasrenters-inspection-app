import { isJobRemoved, JOB_LEAVES_THE_PHONE, notificationTarget, withoutJob } from '../src/utils/job-removed';

/** The shape `ApiRefusalError` has, without loading the storage module it lives in. */
const refusal = (status: number, code?: string) => Object.assign(new Error('Assigned inspection was not found.'), { status, code });

describe('a job taken off the phone', () => {
  it('is cancelled, unassigned or given to someone else -- never a job still theirs', () => {
    expect([...JOB_LEAVES_THE_PHONE].sort()).toEqual(['CANCELLED', 'REASSIGNED', 'UNASSIGNED']);
    for (const kind of ['ASSIGNED', 'UPDATED', 'REOPENED', 'EVIDENCE_REQUESTED', 'SYNCED'])
      expect(JOB_LEAVES_THE_PHONE.has(kind)).toBe(false);
  });

  it('is known by the server refusing it as not assigned, and by nothing else', () => {
    expect(isJobRemoved(refusal(404, 'ASSIGNED_INSPECTION_NOT_FOUND'))).toBe(true);
    // Another missing thing, or a refusal of something else, is not the job gone.
    expect(isJobRemoved(refusal(404, 'ASSIGNED_ROOM_NOT_FOUND'))).toBe(false);
    expect(isJobRemoved(refusal(409, 'ASSIGNED_INSPECTION_NOT_FOUND'))).toBe(false);
    // Out of signal is not cancelled: the job must stay on the phone.
    expect(isJobRemoved(Object.assign(new Error('offline'), { reason: 'transport' }))).toBe(false);
    expect(isJobRemoved(null)).toBe(false);
  });
});

describe('withoutJob', () => {
  const job = (id: string) => ({ id, status: 'SCHEDULED' });

  it('takes the job out of a plain list', () => {
    expect(withoutJob([job('a'), job('b')], 'a')).toEqual([job('b')]);
  });

  it('takes it out of a page, and the page total with it', () => {
    const page = { items: [job('a'), job('b')], page: 1, pageSize: 25, total: 2, totalPages: 1 };
    expect(withoutJob(page, 'b')).toEqual({ ...page, items: [job('a')], total: 1 });
  });

  it('takes it out of whichever page of an infinite list holds it', () => {
    const first = { items: [job('a')], page: 1, pageSize: 1, total: 2, totalPages: 2 };
    const second = { items: [job('b')], page: 2, pageSize: 1, total: 2, totalPages: 2 };
    const pages = { pages: [first, second], pageParams: [1, 2] };
    const next = withoutJob(pages, 'b');
    expect(next.pages[0]).toBe(first);
    expect(next.pages[1]).toEqual({ ...second, items: [], total: 1 });
  });

  it('takes it off the home screen, from its assignments and its recent work', () => {
    const home = { today: 2, inProgress: 0, completed: 0, pendingUploads: 0, assignments: [job('a'), job('b')], recent: [job('a')] };
    expect(withoutJob(home, 'a')).toEqual({ ...home, assignments: [job('b')], recent: [] });
  });

  it('hands back the same object when the job was not in it, so nothing redraws', () => {
    const list = [job('a')];
    const page = { items: [job('a')], total: 1 };
    const pages = { pages: [page], pageParams: [1] };
    expect(withoutJob(list, 'z')).toBe(list);
    expect(withoutJob(page, 'z')).toBe(page);
    expect(withoutJob(pages, 'z')).toBe(pages);
    expect(withoutJob(undefined, 'z')).toBeUndefined();
    // The badge query caches a number.
    expect(withoutJob(3, 'z')).toBe(3);
  });
});

describe('where a tapped notification opens', () => {
  it('opens the job it names', () => {
    expect(notificationTarget({ inspectionId: 'a', kind: 'ASSIGNED' })).toBe('/(app)/inspections/a');
    // Reminders carry no kind of this sort.
    expect(notificationTarget({ inspectionId: 'a', kind: 'inspection-reminder' })).toBe('/(app)/inspections/a');
  });

  it('opens the list for a job that was taken away, since the job is no longer there', () => {
    expect(notificationTarget({ inspectionId: 'a', kind: 'CANCELLED' })).toBe('/(app)/(tabs)/(jobs)/inspections');
    expect(notificationTarget({ inspectionId: 'a', kind: 'REASSIGNED' })).toBe('/(app)/(tabs)/(jobs)/inspections');
  });

  it('opens nothing for a notification that names no job', () => {
    expect(notificationTarget({})).toBeNull();
    expect(notificationTarget(undefined)).toBeNull();
  });
});
