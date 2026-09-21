import * as Battery from 'expo-battery';

/**
 * How much charge the phone had, as a whole percentage.
 *
 * `TechnicianLocationPing.batteryPercent` has existed since the table did and
 * has been null on every row ever stored -- `toQueuedFix` simply never set it.
 * The column exists for one question, and it is the question the office asks
 * every time a trail stops: was the phone dead, or was the app killed, or did
 * the technician turn tracking off? A trail that ends at 4% answers itself.
 *
 * ── THE `-1` TRAP, AGAIN ─────────────────────────────────────────────────────
 *
 * `getBatteryLevelAsync` answers `-1` when it cannot tell -- a simulator, or a
 * platform that will not say -- exactly as `coords.heading` and `coords.speed`
 * answer `-1` for "no course" and "no speed". Stored literally that is a
 * battery of minus one percent, which the API would refuse (`@Min(0)`) and
 * which would take the whole batch with it. Null means "nobody knows", which is
 * a different fact from "nearly flat", and the two must not be confused.
 *
 * Read once per delivery rather than once per fix: at a fix every three seconds
 * the level cannot have moved between two of them, and a native call each time
 * is work a phone in somebody's pocket does not need to do.
 */
export async function currentBatteryPercent(
  read: () => Promise<number> = Battery.getBatteryLevelAsync,
): Promise<number | null> {
  try {
    const level = await read();
    // Not `level < 0`: NaN fails every comparison, so ask what is in range.
    if (!(level >= 0 && level <= 1)) return null;
    return Math.round(level * 100);
  } catch {
    // Never throws into the location task. A missing battery reading is a
    // missing diagnostic; losing the fix it was attached to is losing evidence.
    return null;
  }
}
