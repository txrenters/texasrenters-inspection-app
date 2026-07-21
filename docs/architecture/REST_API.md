# REST API

The backend foundation remains available under `/api/v1`, with Swagger at `/api/docs` outside production. Protected requests use bearer tokens; backend-local mock mode accepts `x-mock-user-id`.

Implemented backend groups include health/readiness, current user, administrator technician provisioning, properties, floor plans and extraction jobs, property-area review, inspections and assignments, assignment-scoped technician inspection/room/media reads, room skip/complete, media sessions and processing, findings and reviews, and idempotent mock webhooks. Errors use `{ statusCode, code, message, details, requestId }`.

## Client integration status

The mobile application uses authenticated `Api*Repository` classes by default. They validate server responses and target the assignment-scoped `/api/v1/technician` routes. Its screens use feature hooks and repository interfaces. `Mock*Repository` classes remain available only for explicit demonstrations and isolated tests.

Demo mode is selected only with:

```text
EXPO_PUBLIC_ENABLE_DEMO_DATA=true
```

`EXPO_PUBLIC_API_BASE_URL` is the backend origin and is required for live mobile use. The administrator application uses `NEXT_PUBLIC_API_BASE_URL` for the same backend origin and shared DTOs from `shared/`. Both append versioned `/api/v1` paths and must preserve assignment authorization, approved-room membership, one-media-to-one-inspection-area binding, and human review rules. A newly provisioned technician receives an empty list until an administrator creates a current assignment.

Neither client consumes raw Propertyware responses. Propertyware synchronization and normalization remain backend-only.

## Floor plans and approved property areas

Administrators use organization-scoped routes under `/api/v1/admin` to list and upload private floor-plan files, request optional AI extraction, edit draft property areas, and explicitly approve those areas. Uploads accept PDF, PNG, or JPEG files up to 20 MB and validate both the declared media type and file signature. AI output is validated and always persists as `DRAFT`; it never becomes an inspection area without an authorized human approval.

New inspections snapshot the property's approved master area list into `InspectionArea`. Inspection creation fails when the selected property has no approved areas, preventing an empty or invented mobile workflow.

Administrators create one of `MOVE_IN`, `OCCUPIED`, `BACK_TO_MARKET`, or `MOVE_OUT`. A later lifecycle inspection requires the completed move-in baseline for the same property/unit/lease. Back-to-market additionally follows an occupied inspection, and move-out follows back-to-market. Responses expose the stored baseline relationship so clients never guess which inspection supplies comparison evidence.

Assigned technicians can read the latest approved plan metadata at `GET /api/v1/technician/properties/:propertyId/floor-plan` and its bytes at `GET /api/v1/technician/floor-plans/:floorPlanId/content`. Both routes require a current assignment to an inspection for that property. Private file responses are not cacheable. Draft plans and plans for unassigned properties are never exposed to the mobile client.
