# Floor-plan review UX

## Purpose

The administrator review workspace verifies two independent facts:

1. **Area approval** — whether an extracted area belongs in the inspection checklist.
2. **Marker review** — whether the area marker is usable on the active source plan.

Selecting, placing, or moving a marker never approves an area. Approving an area does not
certify a marker position.

## Screen hierarchy

The property page presents the active source plan first, followed by a compact readiness summary:
extracted areas, approved areas, markers present, and administrator-placed markers. Once areas
exist, **Review extracted areas** is the primary action. Re-extraction, replacement, and opening the
original remain secondary or tertiary actions.

The full-screen review workspace has:

- a compact header with source, floor/page context, progress, marker visibility, and close;
- a persistent plan canvas on wide screens;
- a review panel containing selected-area details, filters, and the extracted checklist;
- a sticky edit footer only while a marker is being adjusted.

## Selection behavior

Checklist rows and markers share one selected-area state. Selecting either surface updates the
other, pans the selected marker into view, announces the selection, and keeps the selected row
visible. Selection has no persistence side effect.

The selected-area summary exposes the checklist requirement, area status, marker status,
confidence when supplied, and relevant marker actions. Normalized coordinates are intentionally
not shown.

## Responsive behavior

At desktop widths the canvas uses roughly two-thirds of the workspace and the review panel uses
one-third. At tablet and narrower widths the workspace becomes a deliberate two-step view. The
administrator switches between **Show plan** and **Review areas**; the canvas is not squeezed beside
an unusably narrow checklist.

## Accessibility

- Checklist rows and markers are semantic buttons.
- Pressed/selected state is exposed through `aria-pressed`.
- Visible focus indicators do not rely on color alone.
- Selection and save results use live regions.
- The dialog traps focus and restores the previous focus on close.
- Escape and backdrop close are protected when marker changes are unsaved.
- A marker can be nudged with arrow keys; Shift increases the step.
- Reduced-motion preferences disable marker pulse and transform animation.

## Error and recovery states

Missing markers remain checklist items and never render at a fake origin. Manual placement is the
primary per-area recovery action. Bulk marker retry is available when supported, but is not the
only correction path. Save failures preserve the local draft for retry and do not report success.

## Source replacement

Replacement creates a new active source version. Before upload, the UI explains that approved
areas remain in history and marker review is required against the new plan. A confirmation is
required before the new version is uploaded.

## Known limitations

The current API records AI-extracted, deterministic, administrator-placed, and
administrator-adjusted marker sources. It does not yet store a separate explicit marker
verification event, so the UI does not claim that an adjusted marker was independently verified.
Visual audit history is not exposed until the backend provides a compact history response.

