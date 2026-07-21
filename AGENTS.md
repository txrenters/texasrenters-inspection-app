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
- Add tests for business rules and authorization boundaries.
- Run lint, typecheck, tests, and builds before reporting completion.
- Report command failures honestly; never claim a command ran when it did not.
