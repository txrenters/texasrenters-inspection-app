# Pagination and filtering

## Contract

Growing collections use validated server-side pagination. The current API format is:

```json
{
  "items": [],
  "page": 1,
  "pageSize": 25,
  "total": 0,
  "totalPages": 0
}
```

New high-volume endpoints default to 25 items and all page sizes are capped at 100. Existing admin table endpoints retain their established default while enforcing the same maximum. Use Prisma `skip`/`take` for the current modest datasets. Consider cursor pagination only after measurement shows a large or frequently changing chronological collection needs it and update the client contract atomically.

## Filter construction

- Transform numeric page parameters through DTO validation.
- Trim search input and cap it at 120 characters.
- Allowlist status, type, and boolean-like values.
- Parse dates as validated ISO dates and reject inverted ranges.
- Scope every query by organization and role-derived authorization.
- Use Prisma parameterization; never concatenate untrusted SQL.
- Apply search/status/date/property/technician filters in Prisma, not after retrieving a full table.

Supported important filters include property portfolio/city/state/active/move-out/unassigned state; unit active/vacancy/search; lease active/status/move-out range/search; inspection property/portfolio/technician/status/assignment/date/search; assignment technician/property/status/date; technician search/active/onboarding; and Propertyware run status/type/date.

Growing child collections are pages too: inspection audit events, inspection/technician assignment history, Propertyware sync errors, technician findings, and the legacy Propertyware catalog all use the same bounded contract. A detail endpoint must not embed one of these histories merely to avoid an independent section request.

## Client behavior

Web text search is debounced and obsolete requests carry an `AbortSignal`. Mobile inspection status and search are sent to the server; card components use embedded summaries and do not make per-card property/room requests. Lazy selectors request bounded pages rather than loading a full catalog into the browser.

An empty page is valid and must include pagination metadata. Clients must not infer “all data loaded” from fewer items unless `totalPages` or the endpoint’s next-page metadata confirms it.
