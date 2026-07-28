# Guided area recording

Primary room evidence uses three complementary layers:

1. **Live guidance** — Wall 1 setup, clockwise arrow, progress estimate, short prompts, and optional haptics.
2. **Sensor validation** — cumulative clockwise rotation and return-to-start estimation.
3. **Evidence validation** — a wide area photo, focused finding photos, and technician confirmation.

Sensors estimate device movement; they do not prove that every surface was visible. The review screen
always requires the technician to confirm evidence coverage before a primary walkthrough is queued.

Additional issue videos remain a simplified, labelled workflow and never replace the primary recording.

## States

`PREPARE → READY → RECORDING → FINALIZING → REVIEW → QUEUED`

- Prepare establishes the entrance/Wall 1 reference and requests motion access.
- Recording keeps the camera primary and overlays only contextual guidance.
- Review separates recording saved, guided-capture estimate, evidence completeness, and technician confirmation.
- Queueing is local-first; field work continues while transfers run independently.

The record-room surface is a full-height camera experience rather than a scrollable form. Its
snapshot, record/stop, and finding controls remain fixed inside the bottom safe area on every device
height. Preparation is shown once as a blocking Wall 1 overlay; after dismissal, only live rotation
and evidence feedback may overlay the viewfinder. Camera permission errors remain actionable without
hiding or displacing the capture workflow.

Policy values live in `mobile-app/src/capture/guided-capture.ts`.
