# Reviewing a floor plan and its extracted areas

Administrator guide for the *Compare plan and extracted areas* screen
(Property → Floor plans → **Compare plan and extracted areas**).

## Finding an area on the plan

1. Click any area in the checklist (rows are buttons — `Tab` and `Enter` work).
2. The row highlights and a square marker with the area's name appears over that
   room on the plan, pulsing briefly so it is easy to spot.
3. The plan pans to bring the marker into view; the zoom level is left alone.
4. Clicking another area moves the selection and the marker.
5. Clicking a **marker** selects its checklist row — the two stay in sync.

Selecting an area **never** approves, rejects, or otherwise changes it.

## Show all markers

Off by default. When enabled, every area with coordinates on the current plan is
shown at once; the selected area stays emphasised and the rest render quietly with
their inspection-order number. Any marker can be clicked to select its row.

## Zoom and pan

Use **+ / −**, **Reset**, or the mouse wheel. When zoomed in, drag the plan to
pan. **Focus selected** zooms toward the selected area — fitting its bounding box
when one exists, otherwise centring the marker with surrounding context. Zooming
is never required to select an area.

## Correcting a marker

AI placement is a draft suggestion.

- **Marker not available** on a row means no coordinates exist for the current
  plan (a legacy area, an area from an older plan version, or one the model could
  not place). Click **Place marker**.
- Otherwise click **Adjust marker**.

Then position it by dragging the marker, clicking the correct point on the plan,
or nudging with the arrow keys (hold **Shift** for larger steps). Click **Save
position** to persist, or **Cancel** to discard. Nothing is saved until you click
save, and saving a marker does not change the area's approval status.

If a save fails you will see *Unable to save marker position. Your previous
position has not been changed.* — the stored position is untouched; retry.

## Backfilling markers on an older extraction

If a plan's areas were extracted before markers existed, an administrator can
re-run extraction to fill in the missing positions without disturbing the
checklist: it only adds coordinates to areas that lack them, and never changes
names, ordering, or approval status. Areas it cannot match are left for manual
placement.

## After replacing a floor plan

Markers belong to the specific plan version they were derived from. Upload a new
plan and re-run extraction to get markers for it; the previous plan's areas and
approvals are preserved and are not silently re-pointed at the new image. Areas
carried over from an earlier plan show *Marker not available* until placed.

## PDF plans

PDF plans work too — the page is rendered for you, and markers behave exactly as
they do on an image plan. Multi-page PDFs show a **Page N of M** control beneath
the plan:

- Markers belong to the page you placed them on, so only that page's markers are
  shown.
- Changing pages clears the current selection.
- Placing a marker records the page you were viewing.

Very large PDFs take a moment to render; you will see *Rendering the PDF page…*
first. If a page cannot be rendered you get a link to open the original PDF.

## Permissions

Viewing the review screen and markers needs `properties:read`. Placing or
adjusting a marker needs `properties:manage`. Technicians cannot modify markers.
