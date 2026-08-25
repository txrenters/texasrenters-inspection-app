/**
 * The two capture decisions the camera screen used to make inline.
 *
 * They live here rather than inside the screen because they are the parts worth
 * asserting, and this project has no React renderer — a rule buried in a
 * 900-line component cannot be tested at all. See tests/capture-intents.test.ts.
 */

/**
 * Whether a shutter tap can take a still, or only mark the moment.
 *
 * Android binds either expo-camera's image-capture or its video-capture use
 * case, never both, so `takePictureAsync` has nothing to shoot with while a
 * recording runs. The shutter records the offset instead, and the frame is cut
 * out of the finished video by `extractMarkerStills`.
 *
 * Written as one decision with two outcomes rather than an early return,
 * because an early return is what caused the bug this replaces: the marker path
 * left before any of the feedback ran, so an Android technician mid-walkthrough
 * saw nothing happen at all. Both outcomes now rejoin the same code.
 */
export function snapshotMode(platform: string, recording: boolean): 'marker' | 'still' {
  return recording && platform === 'android' ? 'marker' : 'still';
}

/**
 * What a tap on either stop control should do.
 *
 * Ending a take is reachable from two places — the red button and the header
 * back arrow, which doubles as stop mid-recording — so the rule has to be one
 * thing both consult rather than a condition written twice.
 *
 * `stopping` is already true from the moment stop is confirmed until the take
 * finishes saving, which is what keeps a second tap from stacking a second
 * confirmation on top of the first.
 */
export function stopRequestOutcome({
  recording,
  stopping,
}: {
  recording: boolean;
  stopping: boolean;
}): 'ignore' | 'confirm' {
  return recording && !stopping ? 'confirm' : 'ignore';
}
