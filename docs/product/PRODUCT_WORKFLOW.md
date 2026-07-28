# Product Workflow

## Demonstrable frontend workflow

1. The user enters Demo Mode and selects technician, reviewer, or administrator.
2. The dashboard loads realistic local assignments through repository-backed TanStack Query hooks.
3. The technician opens a property, reusable floor plan, and approved room checklist.
4. The lifecycle begins with move-in, may contain repeated occupied checks, continues with back-to-market (normally about 60 days before lease end), and finishes with move-out.
5. Move-in captures the initial property condition. Every later lifecycle inspection is linked to and compared against that immutable move-in baseline.
6. The technician grants camera and microphone access, records one room-specific video, and stops before leaving the room.
7. The recording is moved from temporary camera cache into durable app document storage. Recording Review provides local playback, duration, size, timestamp, and notes.
8. Save & queue creates one durable media record and one idempotent queue item bound to that inspection room, then immediately advances the technician to the next unfinished approved room.
9. The foreground queue uploads independently of the current screen. Offline recordings remain accessible in SQLite-backed device state and retry automatically with bounded backoff when connectivity returns.
10. After backend confirmation, processing transcribes the room video, stores the protected transcript, generates a concise condition summary and findings against the baseline, and marks every AI result `PENDING_REVIEW`.
11. Findings are grouped by room and remain `PENDING_REVIEW` until an authorized human action.
12. Approve requires confirmation. Reject and reinspection require reasons. Edit records reviewer context.
13. Review actions never authorize a tenant charge or decide legal responsibility.

Reset Demo Data restores the original user, room status, notes, media, upload queue, failures, settings, and finding decisions.

## Future connected workflow

The existing company application remains the source of property, owner, and portfolio data. A future NestJS integration layer will consume and normalize that system’s API. The mobile repository container will then select REST implementations explicitly; screens and feature hooks remain unchanged.
