# Mobile overlay standard

- Mount exactly one `PortalHost` at the application provider root.
- Use generated `Dialog` for forms and informational overlays.
- Use generated `AlertDialog` for destructive confirmation.
- Keep the overlay controlled by the screen. Mutation success closes it; mutation failure remains
  visible and actionable.
- Use a ScrollView inside long dialog content and keyboard avoidance on iOS forms.
- Give every overlay a title, description, close path, and accessible actions.
- Do not stack native `Modal` and portal dialogs for ordinary application forms.
- The camera intro, capture-type sheet, and brief recording/photo guides are documented exceptions:
  they belong to a full-screen native capture surface and require deterministic camera layering.
- Never hide a focused descendant behind an inactive accessibility tree. Move focus or close the
  overlay through its primitive.

