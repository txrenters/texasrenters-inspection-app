# MVP Scope

## Frontend-first status

The active MVP is a demonstrable Expo field-service application that runs in mock mode without a `.env`, backend, database, or provider credentials. It proves the technician and human-review experience before external and backend contracts are finalized.

Included frontend capabilities:

- Persistent demo role selection and a visible Demo Mode indicator
- Dashboard, inspection search/filter, inspection overview, floor-plan placeholder, and approved room list
- Four properties, five inspections, multiple floors, realistic baselines, existing defects, local media, upload states, and findings
- Functional on-device camera and microphone recording per selected room, durable local storage and playback, plus simulated upload and processing stages
- Offline simulation, retained failure/retry state, review decisions, required reasons, and reset
- Repository interfaces with mock implementations and API adapter skeletons

The NestJS, Prisma, Docker, and shared-schema foundations remain in the repository and independently buildable, but are not frontend startup dependencies.

Excluded: live external-property integration, Supabase authentication, Cloudflare Stream, speech providers, Anthropic, production background upload, floor-plan OCR/geometry, computer vision, repair estimates, tenant charge calculation, financial approval, portals, push notifications, and cloud deployment.

AI output is always presented as an uncertain observation. It cannot approve responsibility, legal conclusions, deductions, expenses, or tenant charges.
