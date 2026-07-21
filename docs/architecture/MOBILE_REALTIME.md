# Mobile assignment delivery

Inspection assignments use two authenticated delivery paths:

- A backend-owned Socket.IO namespace (`/technician-events`) refreshes an open technician app immediately.
- Expo Push delivers the assignment alert while a development/production build is backgrounded or closed.

The socket authenticates the Supabase access token and derives the technician room from the active application profile. The client cannot select another technician's room. Events carry only an inspection identifier and event type; inspection data remains behind the technician REST authorization boundary.

The mobile dashboard and inspection list use a 10-second foreground fallback refresh in case a socket is temporarily unavailable. Detail payloads are not polled. App resume also invalidates the assignment caches.

Expo push tokens are registered through the technician REST controller and stored against the authenticated profile. An administrator assignment emits only after its serializable database transaction commits. A new assignment fans out to the connected socket and all active push devices.

Remote push registration requires `EXPO_PUBLIC_EAS_PROJECT_ID` and a development or production build. Without an EAS project identity, an open app still receives realtime socket events and a local notification.
