# Guided room-video capture

Before (and during) recording, the technician can open a **Recording guide** — a
compact, numbered step checklist rather than a paragraph — so the primary area
video is captured consistently.

The sequence is chosen by the area's `environment`:

- **Indoor** (`INDOOR`): entrance → announce property/area/type → wide doorway
  view → clockwise ~360° → each wall top-to-bottom → ceiling/floor/doors/windows/
  closets/fixtures → pause on defects → describe findings aloud → utilities/
  appliances/safety devices → focused coverage of any extra issue.
- **Outdoor** (`OUTDOOR` / `SEMI_OUTDOOR`): clear reference point → clockwise
  around the perimeter → fencing/gates/walls/ground/drainage/landscaping/
  structures/damage → avoid unsafe movement or trespassing.

Content and version live in `mobile-app/src/utils/video-capture-guide.ts`
(`VIDEO_GUIDE_VERSION`). The guideline version is persisted onto each recording
via `InspectionMedia.captureGuidelineVersion` (both the primary walkthrough and
additional labeled clips carry it).

## Additional labeled clips

From a room, **Add additional video** records a supplementary clip that is stored
alongside the primary walkthrough without replacing it (see
[VIDEO_PIPELINE.md](./VIDEO_PIPELINE.md)). On the review screen the technician
enters a required short **label** and an optional **category** (additional damage,
appliance test, plumbing, electrical, pest, pet evidence, safety, exterior,
follow-up, re-inspection, other). The clip uploads through the same durable
offline queue, but posts to `/technician/rooms/:roomId/videos` and never marks the
room complete. Reviewers see the label, category, and an "Additional" chip beside
the primary recording in the web console.
