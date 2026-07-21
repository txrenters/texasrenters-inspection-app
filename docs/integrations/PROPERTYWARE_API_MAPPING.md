# Propertyware API mapping

Verified against the official OpenAPI page on 2026-07-18. Base URL: `https://api.propertyware.com/pw/api/rest/v1`. Paths are case-sensitive. Every request sends `x-propertyware-client-id`, `x-propertyware-client-secret`, and `x-propertyware-system-id` (organization ID).

| Entity    | Read endpoint     | Response                          | Filters used                                                                                                                 | Selected fields                                                                                                    |
| --------- | ----------------- | --------------------------------- | ---------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------ |
| Portfolio | `GET /portfolios` | `PortfolioDTO[]`; `X-Total-Count` | `offset`, `limit`, `lastModifiedDateTimeStart`, `lastModifiedDateTimeEnd`, `includeDeactivated`, `includeCustomFields=false` | `id`, `name`, `abbreviation`, `active`, timestamps, `owners[].id/name/percentageOwnership`                         |
| Building  | `GET /buildings`  | `BuildingDTO[]`; `X-Total-Count`  | same incremental filters and `includeDeactivated`                                                                            | `id`, `portfolioID`, `idNumber`, `name`, `abbreviation`, `active`, `status`, `propertyType`, `address`, timestamps |
| Unit      | `GET /units`      | `UnitDTO[]`; `X-Total-Count`      | same incremental filters and `includeDeactivated`                                                                            | `id`, parent IDs, name, active/status/type, bedroom/bathroom counts, address, timestamps                           |
| Lease     | `GET /leases`     | `LeaseDTO[]`; `X-Total-Count`     | `offset`, `limit`, modified range, `includeCustomFields=false`                                                               | `id`, parent IDs, name/status/active, lease and move dates, reason, minimal contact display names, timestamps      |

The documented maximum `limit` is 500. The lease list documents `scheduleMoveOutDateStart`/`scheduleMoveOutDateEnd` (without a `d` in `schedule`) and the response field is `scheduleMoveOutDate`. It does not document `includeDeactivated`; the client therefore never sends that parameter for leases.

All portfolio, building, and unit list requests send `includeDeactivated=false` in every sync mode. The client also filters out an inactive row if the provider unexpectedly includes one. Reconciliation detects deactivation by comparing a successfully completed active feed with previously synchronized IDs.

Single-record paths are `GET /portfolios/{portfolioID}`, `GET /buildings/{buildingID}`, `GET /units/{unitID}`, and `GET /leases/{leaseId}`. The validated client supports these detail responses for targeted lookup and future parent-repair work; the first bulk worker continues to use paginated list endpoints.

Live validation on 2026-07-20 confirmed that the configured account's active-only
building list returns multiple pages. Records without a required `portfolioID` are
quarantined as sanitized schema errors and are never persisted.

If the official portfolio endpoints return 403, operators may configure a temporary
`PROPERTYWARE_PORTFOLIO_REPORT_URL` from `app.propertyware.com`. The backend validates
the report's `{ totalCount, columns, records }` shape, maps only Portfolio Name,
Portfolio Entity ID, and Deactivated, and never sends API credentials to the report
origin. The opaque URL is secret configuration, not a committed API contract. Owner
strings from the report are intentionally not persisted because they lack stable IDs.
