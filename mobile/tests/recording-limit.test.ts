import {
  MAX_RECORDING_SECONDS,
  RECORDING_LIMIT_WARNING_SECONDS,
  recordingTimeLeft,
  stoppedByLimit,
} from '../src/capture/recording-limit';

/**
 * How long one area's recording may run (Moses, 2026-10-02: the
 * office's previous app stopped at 29 seconds).
 */

describe('the recording limit', () => {
  it('is ten minutes a take', () => {
    expect(MAX_RECORDING_SECONDS).toBe(600);
  });

  it('says nothing until the last minute, then counts down to zero', () => {
    expect(recordingTimeLeft(0)).toBeNull();
    expect(recordingTimeLeft(MAX_RECORDING_SECONDS - RECORDING_LIMIT_WARNING_SECONDS - 1)).toBeNull();
    expect(recordingTimeLeft(MAX_RECORDING_SECONDS - RECORDING_LIMIT_WARNING_SECONDS)).toBe(60);
    expect(recordingTimeLeft(MAX_RECORDING_SECONDS - 5)).toBe(5);
    expect(recordingTimeLeft(MAX_RECORDING_SECONDS + 3)).toBe(0);
  });

  it('tells a take the limit ended from one the technician ended', () => {
    expect(stoppedByLimit(MAX_RECORDING_SECONDS, false)).toBe(true);
    // The clock beside the recording drifts by a tick.
    expect(stoppedByLimit(MAX_RECORDING_SECONDS - 1, false)).toBe(true);
    expect(stoppedByLimit(MAX_RECORDING_SECONDS, true)).toBe(false);
    expect(stoppedByLimit(120, false)).toBe(false);
  });
});
