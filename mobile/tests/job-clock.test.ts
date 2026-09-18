import { formatTimer, formatWorked, jobClock, jobClockLabel, jobElapsed } from '../src/utils/job-clock';

/**
 * One clock for the whole job: Start job to Submit (the office, 2026-09-18).
 * Both ends are the server's stamps, which is what makes them worth reading.
 */

const STARTED = '2026-09-18T14:06:00.000Z';
const at = (iso: string) => Date.parse(iso);

describe('how long a job has taken', () => {
  it('counts in minutes for the first hour', () => {
    expect(formatWorked(0)).toBe('0 min');
    expect(formatWorked(8)).toBe('8 min');
    expect(formatWorked(59)).toBe('59 min');
  });

  it('turns into hours and padded minutes after that', () => {
    expect(formatWorked(60)).toBe('1 h 00 m');
    expect(formatWorked(64)).toBe('1 h 04 m');
    expect(formatWorked(185)).toBe('3 h 05 m');
  });

  it('never counts backwards when the handset clock is behind the server', () => {
    // The start is stamped by the server. A phone a minute behind it would show
    // a job that has run for -1 minutes, which reads as a bug in the app.
    expect(formatWorked(-3)).toBe('0 min');
    expect(jobClock({ startedAt: STARTED }, at('2026-09-18T14:05:00.000Z'))?.worked).toBe('0 min');
  });
});

describe('the job clock', () => {
  it('is absent until the job is started, which is when Start job shows instead', () => {
    expect(jobClock({}, at(STARTED))).toBeNull();
    expect(jobClock({ startedAt: undefined, submittedAt: undefined }, at(STARTED))).toBeNull();
  });

  it('runs from the start while the job is open', () => {
    const clock = jobClock({ startedAt: STARTED }, at('2026-09-18T14:40:00.000Z'));

    expect(clock).toMatchObject({ running: true, worked: '34 min' });
    expect(jobClockLabel(clock!)).toContain('running 34 min');
  });

  it('stops at the submission, and reads the same afterwards', () => {
    const job = { startedAt: STARTED, submittedAt: '2026-09-18T15:10:00.000Z' };

    const atSubmission = jobClock(job, at('2026-09-18T15:10:00.000Z'));
    const aWeekLater = jobClock(job, at('2026-09-25T09:00:00.000Z'));

    expect(atSubmission).toEqual(aWeekLater);
    expect(atSubmission).toMatchObject({ running: false, worked: '1 h 04 m' });
    // "took", not "running": a finished job must not read as still going.
    expect(jobClockLabel(atSubmission!)).toContain('took 1 h 04 m');
  });

  it('ignores a stamp that is not a time', () => {
    expect(jobClock({ startedAt: 'not a date' }, at(STARTED))).toBeNull();
    // A broken submission stamp leaves the job running rather than discarding
    // the clock: the start is the fact worth showing.
    expect(jobClock({ startedAt: STARTED, submittedAt: 'nonsense' }, at('2026-09-18T14:20:00.000Z'))).toMatchObject({
      running: true,
      worked: '14 min',
    });
  });
});

/** The office (2026-09-18): "if they confirm time tracker starts". */
describe('the time tracker on a running job', () => {
  it('reads hours, minutes and seconds', () => {
    expect(formatTimer(0)).toBe('00:00:00');
    expect(formatTimer(765_000)).toBe('00:12:45');
    expect(formatTimer(3_723_999)).toBe('01:02:03');
  });

  it('never counts backwards', () => {
    expect(formatTimer(-5_000)).toBe('00:00:00');
  });

  it('runs from the server’s start until the job is submitted', () => {
    expect(jobElapsed({}, at(STARTED))).toBeNull();
    expect(jobElapsed({ startedAt: STARTED }, at('2026-09-18T14:18:45.000Z'))).toBe(765_000);
    expect(
      jobElapsed({ startedAt: STARTED, submittedAt: '2026-09-18T14:48:00.000Z' }, at('2026-09-18T20:00:00.000Z')),
    ).toBe(42 * 60_000);
  });
});
