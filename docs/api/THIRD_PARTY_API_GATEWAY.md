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
| `GET /gateway/technician-locations` | `technicians:read` |

`technician-locations` is the most sensitive of these: it says where a named
employee was at a given minute. It sits behind `technicians:read` rather than
`inspections:read` for that reason — the same boundary the console draws — and
it is read-only. Handsets report their own positions; nothing outside this
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

| Status | When |
| --- | --- |
| 401 | Missing, malformed, unknown, revoked or expired key; wrong secret; environment mismatch; bad or stale signature |
| 403 | Route not open to integrations; permission not held; source address not allowlisted; unsigned write |
| 429 | Client's per-minute allowance spent |

401 says the same thing for every cause. Distinguishing "unknown key" from "wrong
secret" from "revoked" hands an attacker a probe for which prefixes exist.
