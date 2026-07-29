# Mobile screen layout standard

## Standard screen

1. `AppScreen` owns the top and bottom safe-area insets.
2. The title, subtitle, and optional header action must wrap at compact widths.
3. Scroll content uses full width, `minWidth: 0`, and internal horizontal padding.
4. Sticky bottom actions live outside the scroll content. Scroll padding includes the action height
   and device bottom inset.
5. Do not add horizontal ScrollViews to fix application layout.
6. Rows that contain variable text use `flexShrink: 1`, `minWidth: 0`, or wrap.
7. Cards are used for bounded summaries and evidence groups, not as the default page structure.

## Camera screen

The room recorder is a full-screen exception:

- camera preview fills the route;
- status and guidance are overlays;
- top controls use the top safe area;
- snapshot, record, and finding controls use the bottom safe area;
- no scrolling is required to start, stop, or take a snapshot;
- guides appear once and remain dismissible;
- stopping leads to review without waiting for upload completion.

## Responsive validation widths

- compact: 320–375 px;
- standard: 390–393 px;
- large: 428–430 px.

Test long names, large text, keyboard-open input, light/dark themes, loading, empty, error, offline,
queued, uploading, and processing states.

