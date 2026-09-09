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
 * Which use case the camera binds when the screen opens.
 *
 * `mode` on `CameraView` selects image **or** video output — never both — and
 * this screen hard-coded `video`. So the image-capture use case was never
 * bound, and a technician who had not started recording could not take a
 * photograph at all: on Android `takePictureAsync` has nothing to shoot with.
 *
 * It looked like a rule ("you must film before you can photograph") and was
 * really a default nobody had revisited. Reported from the field 2026-09-10:
 * an occupied visit is often *only* photographs — the technician looks at the
 * room, takes a picture, leaves a note, and films only if something warrants
 * it.
 *
 * So an occupied visit opens ready to photograph, and every other visit opens
 * ready to film, which is what its technician does first. Recording still works
 * from either: the screen rebinds the camera when the take starts.
 *
 * Keyed on the same `inspectionRequiresAreaRecording` the completion gate uses,
 * passed in as a boolean so this file stays free of the type taxonomy.
 */
export function initialCameraMode(requiresRecording: boolean): 'picture' | 'video' {
  return requiresRecording ? 'video' : 'picture';
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
