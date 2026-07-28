# Query-key standard

Keys are factories, not inline arrays. A root key addresses every representation of an entity
family, and a detail key addresses one authoritative view.

Web keys live in `web-app/lib/queries.ts`:

- `keys.all`
- `keys.propertiesRoot`, `keys.property(id)`, `keys.propertyAreas(id)`
- `keys.inspectionsRoot`, `keys.inspection(id)`, and inspection child keys
- `keys.assignmentsRoot`, `keys.techniciansRoot`
- `keys.usersRoot`, `keys.rolesRoot`
- `keys.propertyware`, `keys.syncRuns`

Mobile keys live in `mobile-app/src/features/queries.ts`:

- `queryKeys.all`
- `queryKeys.inspectionsRoot`, `inspection(id)`, `inspectionContext(id)`
- `queryKeys.roomsRoot`, `roomRoot`, `rooms(id)`, `room(id)`
- `queryKeys.uploads`, `findingsRoot`, `finding(id)`

Mutation response patching may use a family root to update list, detail, dashboard, and nested
representations recursively. Verification must list only directly affected roots. Unrelated
queries must not be invalidated.

