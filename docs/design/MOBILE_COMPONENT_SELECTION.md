# Mobile component selection

Use generated React Native Reusables primitives for ordinary application UI. Keep custom components
only where the product behavior is specialized.

| Need | Component | Rule |
|---|---|---|
| Primary/secondary/destructive action | `Button` through `AppButton` | Keep a 44 px minimum target and explicit busy state |
| Status | `Badge` through `StatusBadge` | Use operational semantic tokens, not hard-coded colors |
| Bounded summary | `Card` | Do not wrap every section in a card |
| Text input | `Input` | Include an accessible label and visible field label |
| Long-form input | `Textarea` | Use for notes, reasons, and review comments |
| Recoverable message | `Alert` | Use a clear title, useful description, and nearby recovery action |
| Non-destructive overlay | `Dialog` | One root portal; caller controls close state |
| Destructive confirmation | `AlertDialog` | Do not auto-close before an async mutation confirms |
| Progress | `Progress` | Provide an accessible numeric value |
| Initial loading | `Skeleton` plus compact branded loader | Respect reduced motion |
| Full-screen capture | custom camera surface | Controls remain inside safe areas and never require scrolling |
| Search with embedded icon | legacy `SearchInput` adapter | Retain until a generated composition matches native focus behavior |
| Filter chip / taxonomy choice | custom Pressable chip | Use selected accessibility state and semantic tokens |

The compatibility adapters in `src/components/ui.tsx` are migration boundaries, not a second design
system. They preserve existing domain APIs while delegating their rendered primitive to generated
components.

