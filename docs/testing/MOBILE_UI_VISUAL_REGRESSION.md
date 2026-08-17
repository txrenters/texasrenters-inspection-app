# Mobile UI visual regression runbook

## Automated gate

Run from the repository root:

```powershell
npm run lint --workspace @texasrenters/mobile
npm run typecheck --workspace @texasrenters/mobile
npm test --workspace @texasrenters/mobile
npm run build --workspace @texasrenters/mobile
npm exec --workspace @texasrenters/mobile -- expo-doctor
```

Also export an iOS bundle to a temporary directory. Do not commit export artifacts.

## Web viewport smoke test

Inspect 320x568, 375x667, 393x852, and 430x932:

- welcome, login, and password change;
- all four tabs;
- inspection overview, area list/detail, finding list/detail, and report;
- property detail and missing/available floor plan;
- loading, empty, error, offline, queued, uploading, and processing;
- light and dark mode;
- no horizontal overflow or clipped action.

The web preview is useful for layout only. It does not validate camera, microphone, haptics, or
native keyboard behavior.

## Physical iPhone gate

1. Open with Expo Go or the development build over LAN.
2. Verify top/bottom safe areas on a notched device.
3. Open the keyboard in every form and confirm the focused control and action remain reachable.
4. Start a room recording without scrolling.
5. Take a snapshot while recording, mark a finding, stop, review, and queue the upload.
6. Continue to the next room while upload runs in the background.
7. Disable connectivity, save another room, relaunch, and verify durable queued state.
8. Restore connectivity and verify automatic resume without a visible pull-to-refresh.
9. Verify camera permissions, microphone narration, haptics, reduced motion, and large text.

Record device model, iOS version, build type, network condition, screenshots, and any failure. A
repository export or simulator result must not be recorded as a physical-device pass.

