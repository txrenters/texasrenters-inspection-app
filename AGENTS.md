# Coding Agent Rules

- Read relevant product and architecture documentation before changing code.
- Work directly in this repository; never create a nested duplicate project root.
- Preserve unrelated files and the source proposal PDF.
- Never expose or commit secrets, tokens, provider credentials, or private payloads.
- Preserve the REST boundary: the frontend never queries PostgreSQL or uses privileged credentials.
- Explain any new dependency and keep frontend and backend independently buildable.
- One video belongs to exactly one approved room and one inspection area.
- AI-extracted room tags remain drafts until an authorized human approves them.
- AI findings remain `PENDING_REVIEW` until an authorized human reviews them.
- AI cannot approve tenant charges or make legal-responsibility decisions.
- Validate all external, webhook, and AI payloads before persistence.
- Count what a billed provider call costs (Mapbox, Google, AI providers, Cloudflare Stream, SMS/email) per user action, and how often that action repeats. Never put one on a path re-read after every edit, on a poll, or once per item of a large list, unless it is cached on what actually changed and bounded by a daily ceiling; test the call count with a realistic large case. (October 2026: the Group maker re-read a panel after every edit, each read timed ~400 properties through Mapbox, and one day cost $764.)
- Add tests for business rules and authorization boundaries.
- Run lint, typecheck, tests, and builds before reporting completion.
- Report command failures honestly; never claim a command ran when it did not.
