import { currentBatteryPercent } from '../src/location/battery';

jest.mock('expo-battery', () => ({ getBatteryLevelAsync: jest.fn() }));

/**
 * `TechnicianLocationPing.batteryPercent` has been null on every row ever
 * stored: the column was added for one question -- when a trail stops, was the
 * phone dead? -- and nothing ever filled it in.
 *
 * The trap these pin is the same one `normaliseMotion` exists for. Both
 * platforms answer `-1` for "cannot tell", and `-1` stored literally is a
 * battery of minus one percent: the API refuses it (`@Min(0)`) and takes the
 * whole batch of fixes down with it. Null is "nobody knows", which is a
 * different fact from "nearly flat".
 */
describe('the charge recorded with a fix', () => {
  it('is a whole percentage', async () => {
    await expect(currentBatteryPercent(async () => 0.42)).resolves.toBe(42);
    await expect(currentBatteryPercent(async () => 1)).resolves.toBe(100);
    await expect(currentBatteryPercent(async () => 0)).resolves.toBe(0);
  });

  it('rounds rather than truncating, so 99.6% is not 99', async () => {
    await expect(currentBatteryPercent(async () => 0.996)).resolves.toBe(100);
  });

  it('is null when the phone answers -1 for "cannot tell"', async () => {
    await expect(currentBatteryPercent(async () => -1)).resolves.toBeNull();
  });

  it('is null for anything else out of range, including NaN', async () => {
    await expect(currentBatteryPercent(async () => Number.NaN)).resolves.toBeNull();
    await expect(currentBatteryPercent(async () => 1.5)).resolves.toBeNull();
  });

  /**
   * Never throws into the location task. A missing diagnostic is a missing
   * diagnostic; losing the fix it was attached to is losing evidence.
   */
  it('is null when reading it throws', async () => {
    await expect(
      currentBatteryPercent(async () => {
        throw new Error('no battery service');
      }),
    ).resolves.toBeNull();
  });
});
