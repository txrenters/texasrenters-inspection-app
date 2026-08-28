# Third-party API gateway

How an outside system authenticates against this API, what it can reach, and the
decisions behind those limits.

Console: **IT tools → API** (the generated reference) and **IT tools → API
clients** (registration and keys). Both are behind `system:manage`.

## The shape of it

A third party is represented by an **API client** — an identity with an
organization and a set of permission keys — and authenticates with one or more
**keys** issued to that client. The two are separate so a key can be rotated
without the integration losing its identity, its scopes, or its audit history:
issue the replacement, let both work while the third party redeploys, then revoke
the old one.

`ApiKeyGuard` resolves a key to the same `AuthenticatedUser` shape a signed-in
person produces. That is the load-bearing design decision: `PermissionsGuard`
authorizes machine traffic, `TenantScopeInterceptor` scopes its queries, and the
row-level security policies police them — all unchanged. There is no second
authorization path for machines to drift out of step with the first.

## Headers

| Header | Required | Purpose |
| --- | --- | --- |
| `x-api-key` | always | `trk_<env>_<prefix>.<secret>` |
| `x-timestamp` | writes | Unix seconds; must be within 5 minutes of server time |
| `x-signature` | writes | HMAC-SHA256, hex — see below |
| `x-organization-id` | never | The organization comes from the key. A value that disagrees is rejected rather than ignored, so this header cannot be used to probe other tenants |
| `x-request-id` | optional | Client correlation id, echoed back |

Every response carries `x-ratelimit-limit`, `x-ratelimit-remaining` and
`x-ratelimit-reset`, on success as well as on rejection — an integrator should be
able to pace themselves rather than discover the limit by hitting it. A 429 adds
`retry-after`.

### Signing

```
signature = hex(HMAC_SHA256(secret, "METHOD\npath\ntimestamp\nsha256hex(body)"))
```

`path` excludes the query string. `body` is the exact request bytes; an empty
body hashes the empty string.

The method and path are in the signed material deliberately. A signature over the
payload alone says nothing about where the payload was going, so one captured on
a harmless GET could be replayed onto a destructive POST.

**What signing buys, precisely.** Replay protection and integrity binding — not an
independent second factor. The signing key is the same secret already travelling
in `x-api-key`, because the server stores only a hash of that secret and so has
nothing else to sign with; anyone holding the key can sign. It is still required
on writes, because the realistic failure it prevents is not forgery but the same
POST arriving twice — a retried proxy, a replayed capture, a misbehaving client —
and creating two of something that should exist once.

## What a key can reach

Two independent gates, and both must open:

1. **The route must be marked `@MachineAccessible()`.** Default closed. A key
   holding `inspections:read` still gets 403 on an inspection route that is not
   annotated. Without this, shipping the gateway would have made all ~180 routes
   third-party reachable on the same day — including ones that hard-delete
   evidence — because the permission catalog was designed for people looking at a
   screen, not for a credential in someone else's configuration file.
2. **The client must hold the permission**, exactly as a person would.

The reference page shows both per endpoint: `x-required-permissions`,
`x-authentication`, and an "Open to integrations" badge.

The opened surface today is `/api/v1/gateway/*` — a curated, read-only slice.
Every route on it is a `GET`, and tests enforce that:

| Route | Permission |
| --- | --- |
| `GET /gateway/properties` | `properties:read` |
| `GET /gateway/properties/{propertyId}` | `properties:read` |
| `GET /gateway/properties/{propertyId}/units` | `properties:read` |
| `GET /gateway/property-locations` | `properties:read` |
| `GET /gateway/inspections` | `inspections:read` |
| `GET /gateway/inspections/{inspectionId}` | `inspections:read` |
| `GET /gateway/technicians` | `technicians:read` |
| `GET /gateway/technician-locations` | `technicians:locate` |

`technician-locations` is the most sensitive of these: it says where a named
employee was at a given minute. It sits behind `technicians:locate`, a grant of
its own — deliberately *not* `technicians:read`, so that scoping an integration
to the technician directory does not silently scope it to live tracking. It is
read-only. Handsets report their own positions; nothing outside this
system may write one.

### Why a separate `/gateway` prefix

The console's `/admin` endpoints exist to serve the console. Their shapes change
whenever a screen needs them to, and that is fine because both sides ship
together. An integration does not ship with us. Opening `/admin` routes to keys
would silently promote every one of them to a public contract we can no longer
change, and would put the decision about what third parties can reach in the
hands of whoever next edits a controller.

Widening `/gateway` is therefore a deliberate act: add the route, mark it
`@MachineAccessible()`, and accept that its response shape is now something we
have promised to somebody.

## Permissions a key can never hold

`MACHINE_FORBIDDEN_PERMISSIONS` in `shared/src/rbac/permissions.ts`:

`roles:manage`, `users:manage`, `system:manage`, `ai:configure`,
`inspections:delete`, `inspections:finalize`, `charges:review`.

Two categories. **Self-escalation**: `roles:manage` composes the very keys this
list restricts and `users:manage` assigns the roles carrying them, so either one
would make the rest of the list decorative. **Irreversibility**:
`inspections:delete` removes an inspection *and its media* with no restore,
finalization freezes evidence permanently, and charge review is money. A person
holding the permission and looking at the screen may do these things; a
credential sitting in a third party's configuration file may not.

Enforced at issue time (DTO and service) as well as at use time, so a key that
should never have existed cannot be created.

## Rate limiting

Per **client**, not per key — so issuing a second key during a rotation cannot be
used to double an allowance. Redis-backed where available, because the API runs
as several containers behind one proxy and a per-process counter would multiply
every limit by the replica count. The in-process fallback is not an equivalent:
it keeps a Redis outage from removing the limiter altogether, and is deliberately
the stricter reading — each replica enforces the full limit rather than a share.

## Audit

`AuditLog.actorApiClientId` records the machine actor. `actorUserId` is null for
every key-authenticated request, so without this column a third-party write would
be indistinguishable from an anonymous one. Use `auditActor(user)` from
`common/auth.ts` rather than writing `actorUserId: user.id` directly — a machine
principal's `id` is its ApiClient id, and putting that in the user column
produces an audit row pointing at a user that does not exist, silently, because
the column carries no foreign key.

## Configuration

| Variable | Required | Notes |
| --- | --- | --- |
| `API_KEY_PEPPER` | no | ≥32 chars. Keys the hash every secret is stored under. **Derived from `AUTH_JWT_SECRET` when unset**, so key issuance works on any deployment that boots. Set it only to rotate API keys independently of the token-signing secret; rotating `AUTH_JWT_SECRET` otherwise invalidates every issued key (that rotation already signs every user out, so it is not a quiet consequence) |
| `TRUST_PROXY_HOPS` | behind a proxy | Default 0. Must match the real topology for a client's IP allowlist to mean anything — set too low and every request looks like it came from nginx, set too high and the allowlist can be talked around by the caller |

## Server-to-server only

A key placed in browser JavaScript, a mobile bundle, or a committed config file is
a published key. The gateway is not CORS-enabled for third-party origins, and
`allowedCorsOrigins` already refuses `*` in production for credentialed requests.
An integration needing browser access is a different feature — short-lived
delegated tokens — not this one.

## Errors

Every failure carries a stable `code`, so an integration can branch on the cause
rather than parse a message. The body is always the same shape:

```json
{
  "statusCode": 403,
  "code": "API_ROUTE_NOT_OPEN_TO_KEYS",
  "message": "This endpoint is not available to API key clients.",
  "details": [],
  "requestId": "62cdc2d4-163f-4cc6-88e5-7472b80e2ac8"
}
```

Quote `requestId` when reporting a problem: it is in the server logs for that
exact request.

| Status | `code` | Cause | What to do |
| --- | --- | --- | --- |
| 401 | `API_KEY_MISSING` | No `x-api-key` header, or it does not parse | Send the key as `trk_<env>_<prefix>.<secret>` |
| 401 | `API_KEY_INVALID` | Unknown prefix, wrong secret, revoked, expired, wrong environment, or a deactivated client | Check the key; issue a replacement if unsure |
| 401 | `API_SIGNATURE_INVALID` | Signature absent, malformed, outside the five-minute window, or not matching | Recompute per **Signing**. `details[0]` names which |
| 403 | `API_ROUTE_NOT_OPEN_TO_KEYS` | The key is valid; the route is not open to integrations | Nothing — this route is not part of the contract |
| 403 | `API_KEY_ADDRESS_NOT_ALLOWED` | Source address is outside the client's allowlist | Add the address, or clear the allowlist |
| 403 | `API_CLIENT_WRITE_NOT_ENABLED` | A write was attempted by a client that does not require signing | Turn on request signing for the client |
| 403 | `REQUEST_FAILED` | Authenticated, but the client lacks the permission the route enforces | Add the scope to the client |
| 429 | `API_RATE_LIMIT_EXCEEDED` | The client's per-minute allowance is spent | Back off until `retry-after`; raise the limit if it is genuinely too low |

### Why 401 does not tell you which

`API_KEY_INVALID` is deliberately one code with one message for unknown prefix,
wrong secret, revoked, expired and environment mismatch. Splitting them would
hand an attacker a probe for which prefixes exist and which are still live, and
the integrator's next step is identical in every case: check the key.

`API_SIGNATURE_INVALID` *is* distinguished, and safely so — it is only reachable
once the key has already been accepted, so the caller learns nothing they did not
already hold.

## Issuing and managing keys

These are console operations behind `system:manage`, not gateway routes, but
their codes are worth stating since they are what an administrator meets:

| Status | `code` | Cause |
| --- | --- | --- |
| 409 | `API_CLIENT_NAME_EXISTS` | Another client in this organization already has that name |
| 409 | `API_CLIENT_REVOKED` | Keys cannot be issued for a revoked client |
| 404 | `API_CLIENT_NOT_FOUND` / `API_KEY_NOT_FOUND` | No such client or key in this organization |
| 422 | `API_CLIENT_SIGNATURE_REQUIRED` | Write scopes were granted without request signing. `details` lists them |
| 422 | `API_KEY_EXPIRY_IN_PAST` | The expiry given is not in the future |
| 503 | `API_KEY_SIGNING_NOT_CONFIGURED` | The deployment has no signing secret, so no key can be hashed |
