# API endpoint guidelines

TexasRenters clients communicate only through the shared NestJS REST API. Web and mobile code never query PostgreSQL directly and never receive privileged database or provider credentials.

## Endpoint checklist

Before adding or changing an endpoint, answer:

1. Which authorized screen or operation consumes it?
2. Which exact fields does that consumer render or mutate?
3. Which filters belong in PostgreSQL?
4. What is the maximum row count?
5. Which relation summaries are required?
6. Can independent database operations run concurrently within the configured pool limit?
7. Should a list summary and detail contract be separate?
8. Would one compact context endpoint remove a repeated screen waterfall?

## Required implementation practices

- Validate path, query, body, external, webhook, and AI inputs before persistence.
- Build Prisma `where` objects from allowlisted DTO fields; never accept an arbitrary client filter object.
- Use explicit, screen-specific Prisma selects and response mappers.
- Apply organization and role authorization inside every database boundary.
- Use deterministic ordering for every bounded collection.
- Keep growing assignment histories, audit events, sync errors, and findings in separate paginated endpoints instead of embedding them in core detail responses.
- Return the standard safe error contract: `statusCode`, `code`, `message`, `details`, and `requestId`.
- Preserve an actionable upstream error when best-effort failure bookkeeping fails.
- Do not expose raw Propertyware responses, source hashes, storage keys, tokens, prompts, or private provider diagnostics.
- AI-derived rooms and findings stay drafts or `PENDING_REVIEW` until authorized human review.

## Request-waterfall guidance

Create a context endpoint only when one screen consistently needs a cohesive set of authorized data. Keep unrelated or large sections separate. When requests must stay separate and are independent, issue them concurrently, cancel obsolete searches/navigation requests, and share one query hook rather than duplicating calls in child components.

Instrumentation may expose query count and timing headers in controlled development/test runs. Logs must never contain database parameters, secrets, provider payloads, floor-plan bytes, or tenant evidence.
