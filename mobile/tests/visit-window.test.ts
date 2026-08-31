import {
  formatVisitDateAndWindow,
  formatVisitWindow,
  visitStartInstant,
} from '../src/utils/visit-window';

const scheduled = (overrides: Partial<Parameters<typeof formatVisitWindow>[0]> = {}) => ({
  scheduledAt: '2026-09-01T00:00:00.000Z',
  ...overrides,
});

describe('visit window', () => {
  it('shows nothing for a visit booked to a day', () => {
    // The whole point: `scheduledAt` is a date column, so its midnight is an
    // artefact of storage. Rendering it would send a technician somewhere at
    // 12:00 AM.
    expect(formatVisitWindow(scheduled())).toBeNull();
  });

  it('shows the window when the office booked one', () => {
    const window = formatVisitWindow(
      scheduled({
        scheduledStartAt: '2026-09-01T14:00:00.000Z',
        scheduledEndAt: '2026-09-01T16:00:00.000Z',
      }),
    );
    expect(window).toMatch(/–/);
    expect(window?.split(' – ')).toHaveLength(2);
  });

  it('shows a single time when there is a start but no end', () => {
    const window = formatVisitWindow(
      scheduled({ scheduledStartAt: '2026-09-01T14:00:00.000Z' }),
    );
    expect(window).not.toBeNull();
    expect(window).not.toMatch(/–/);
  });

  it('collapses a zero-length window to one time rather than repeating it', () => {
    expect(
      formatVisitWindow(
        scheduled({
          scheduledStartAt: '2026-09-01T14:00:00.000Z',
          scheduledEndAt: '2026-09-01T14:00:00.000Z',
        }),
      ),
    ).not.toMatch(/–/);
  });

  it('ignores an unparseable time instead of rendering Invalid Date', () => {
    // Restored cache payloads are not re-validated, so a bad value can reach
    // this function without ever passing the zod schema.
    expect(formatVisitWindow(scheduled({ scheduledStartAt: 'not-a-date' }))).toBeNull();
    expect(
      formatVisitWindow(
        scheduled({ scheduledStartAt: '2026-09-01T14:00:00.000Z', scheduledEndAt: 'nonsense' }),
      ),
    ).not.toMatch(/Invalid/);
  });
});

describe('visitStartInstant', () => {
  it('counts from the visit start when there is one', () => {
    expect(visitStartInstant(scheduled({ scheduledStartAt: '2026-09-01T14:00:00.000Z' }))).toBe(
      '2026-09-01T14:00:00.000Z',
    );
  });

  it('falls back to the day, so a day-booked inspection behaves exactly as before', () => {
    expect(visitStartInstant(scheduled())).toBe('2026-09-01T00:00:00.000Z');
  });

  it('falls back when the start time is unusable', () => {
    expect(visitStartInstant(scheduled({ scheduledStartAt: 'not-a-date' }))).toBe(
      '2026-09-01T00:00:00.000Z',
    );
  });
});

describe('formatVisitDateAndWindow', () => {
  it('appends the window for a screen reader, which gets one string', () => {
    expect(
      formatVisitDateAndWindow(
        scheduled({ scheduledStartAt: '2026-09-01T14:00:00.000Z' }),
        'Tue, Sep 1',
      ),
    ).toMatch(/^Tue, Sep 1, /);
  });

  it('says only the date when there is no window', () => {
    expect(formatVisitDateAndWindow(scheduled(), 'Tue, Sep 1')).toBe('Tue, Sep 1');
  });
});
