# Administrator interaction states

## Action priority

- **Primary** — the current recommended next action, such as reviewing extracted areas or saving a
  marker position.
- **Secondary** — alternatives such as re-extraction, focusing a marker, or retrying marker
  extraction.
- **Tertiary** — low-risk navigation such as opening the original source.
- **Destructive/risky** — replacement and deletion require explanatory copy and confirmation when
  meaningful state can be lost.

## Floor-plan processing

| State | Administrator feedback | Available action |
| --- | --- | --- |
| Not started | Source is available; no extracted areas | Extract areas or add manually |
| Uploading | File name and active upload label | Wait; cancellation only when supported |
| Queued/processing | Locked modal with staged detection copy and elapsed time | Keep the page open |
| Completed | Area and marker completeness summary | Review extracted areas |
| Completed with warnings | Missing-marker count without blocking valid areas | Review and place markers manually |
| Failed | Sanitized error; existing areas remain unchanged | Retry or manage areas manually |
| Credits unavailable | Existing historical data remains usable | Manual area/marker workflow |
| Legacy result | Areas are shown; marker gaps are explicit | Place markers or retry marker extraction |

## Selection

Selection is local UI state. It synchronizes the checklist and canvas, uses border/background/left
indicator plus `aria-pressed`, and never changes approval or marker persistence.

## Marker edit mode

Entering marker edit mode:

- identifies the area being adjusted;
- disables competing selection/filter controls;
- keeps movement local;
- exposes Save and Cancel in a sticky footer;
- protects workspace close, page change, and area change when the draft differs from persistence.

Success keeps the area selected, shows a status message, and invalidates only the relevant cached
floor-plan/area data. Failure leaves the draft visible for retry.

## Responsive review

Desktop keeps canvas and checklist visible. Tablet and narrow layouts use a plan/review switch
rather than shrinking both panes. Header progress remains visible, while secondary metadata is
condensed.

## Empty and error copy

Copy uses **area**, **floor plan**, **source plan**, **area marker**, **place marker**, and **adjust
marker** consistently. Missing spatial data is described as **Marker missing**, never as a raw
coordinate failure. Error states explain whether persisted data changed.

