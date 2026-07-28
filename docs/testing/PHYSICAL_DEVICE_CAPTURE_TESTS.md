# Physical-device guided capture tests

Run these tests on at least one current iPhone and Android device before release.

## Required matrix

- permissions granted, denied, and restored from Settings
- 360° clockwise turn crossing the 0° heading boundary
- partial turn, wrong-way turn, fast/noisy motion, and sensor unavailable
- return to Wall 1 inside and outside the 20° tolerance
- haptic milestones with haptics enabled and unavailable
- iOS still capture while video continues
- Android timestamp bookmark and post-recording frame extraction
- overview → context → close-up evidence sequence
- finding marker timestamps
- stop/finalize, cancel, retake, app background, interruption, and low storage
- offline save, app restart, reconnect, idempotent photo/video upload, and next-room navigation
- compact phone, large phone, dynamic text, light/dark themes, VoiceOver/TalkBack

## Honest result record

Record device model, OS, Expo/dev-build version, pass/fail, and attached screen recording. Sensor
completion must never be marked as visual-coverage proof. As of the implementation change, automated
math/type checks were run in the Windows workspace; native iOS/Android device execution was not
available to Codex and must remain **NOT RUN** until performed on hardware.
