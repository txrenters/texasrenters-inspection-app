# Floor-plan marker design

## Coordinate contract

Markers remain normalized `0..1` coordinates bound to a source-plan version and, for PDF plans, a
page number. Rendering uses the measured `object-fit: contain` image rectangle so letterboxing,
resize, zoom, and pan do not change alignment.

## Visual states

| State | Treatment | Meaning |
| --- | --- | --- |
| Selected | 18 px square, strong focus outline, label, short locate pulse | Current checklist area |
| AI suggested | Blue square with dashed edge | Extracted position requires human review |
| Administrator placed/adjusted | Green square | Position was explicitly set by an administrator |
| Needs review | Amber square | Source is unknown or legacy |
| Missing | Checklist status only; no canvas marker | No position exists for the active source |
| Unselected/show-all | 12 px, quieter opacity, sequence number | Spatial overview without competing with selection |
| Editing | Selected marker plus sticky save/cancel controls | Local draft; not yet persisted |

Labels stay compact. Near source-image edges they flip above or align inward to reduce clipping.
At low emphasis, only sequence numbers are shown; the selected label always remains visible.

## Interaction

- Click a marker to select its checklist area.
- Click a checklist row to select and focus its marker.
- Use **Show all markers** for an overview; otherwise only the selected marker is rendered.
- Use wheel/trackpad zoom, drag-to-pan, zoom controls, **Fit plan**, or **Focus selected**.
- In edit mode, drag the marker, click the source plan, or use arrow keys.
- Save persists once; Cancel discards the local draft.

Marker movement does not change area approval.

## Contrast and motion

Every marker uses a white inner border plus a colored outer/focus treatment so it remains visible
against dark walls and white paper. Source/status meaning is repeated in text in the checklist and
selected-area panel. Pulse animation is brief and disabled under `prefers-reduced-motion`.

