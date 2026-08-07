import { AsyncLocalStorage } from 'node:async_hooks';

/**
 * The organization the current request belongs to, carried without threading it
 * through every call.
 *
 * Row Level Security needs the tenant on the database session, and Prisma pools
 * connections — so a session-level `SET` would leak one tenant's scope onto the
 * next request that borrowed the same connection. The value therefore has to be
 * set inside a transaction, per operation, which means the code doing the query
 * must know the tenant. Threading an argument through twenty services and every
 * one of their methods was not a realistic change; this carries it out of band
 * instead.
 *
 * `AsyncLocalStorage` survives await boundaries, so a request that fans out into
 * several queries keeps its tenant on all of them.
 *
 * Deliberately holds only the organization id. It is not a general request
 * context, and it must not become one — anything else that wants to ride along
 * would be tempting to read in a service instead of passing it explicitly, and
 * that is how implicit dependencies start.
 */
const storage = new AsyncLocalStorage<string>();

/**
 * Run `fn` with every database query inside it scoped to one organization.
 *
 * Nesting replaces the value rather than merging, which is what the report-share
 * path needs: it starts with no tenant, resolves one from the share token, and
 * continues under it.
 */
export async function withTenant<T>(
  organizationId: string,
  fn: () => T | Promise<T>,
): Promise<T> {
  // `await fn()` INSIDE the store, deliberately. Handing `fn` straight to
  // `run()` and returning its result is the obvious version and it is wrong:
  // Prisma promises are lazy, so `withTenant(org, () => prisma.x.findFirst())`
  // returns before the query executes and the scope has already exited. That
  // mistake produced two concurrent requests reading unscoped data, and then —
  // after being written up in this very file — produced a round of 401s when
  // the policies were tightened. Awaiting here makes it unrepresentable.
  return storage.run(organizationId, async () => fn());
}

/**
 * Bind the tenant to the rest of the current async context.
 *
 * Unlike `withTenant`, this outlives the call that made it, and that is the
 * point. Two things in this codebase execute *after* the function that created
 * them returns:
 *
 * - **Prisma promises are lazy.** `withTenant(org, () => prisma.x.count())`
 *   returns before the query runs, so the extension reads the tenant after the
 *   scope has already exited. Measured: two concurrent requests scoped to
 *   different organizations both saw the *unscoped* result.
 * - **Nest interceptors return an Observable** which Nest subscribes to after
 *   the interceptor chain returns, so the handler runs outside any `run()`.
 *
 * Safe per request because Node gives every inbound HTTP request its own async
 * context; binding here reaches that request's continuations and nothing else.
 *
 * Prefer `withTenant` where the callback awaits its own work — the scope is
 * then visibly bounded. Reach for this only at a boundary that hands work back
 * to a framework, which is why the interceptor is its only caller.
 */
export function enterTenant(organizationId: string) {
  storage.enterWith(organizationId);
}

/**
 * The current organization, or undefined outside a request.
 *
 * Undefined is a normal state, not an error. Boot-time sweeps, the Cloudflare
 * webhook, public report links, password reset and the query that resolves the
 * organization in the first place all run without one, by nature — see the
 * org-less paths listed in docs/migration/SUPABASE_TO_SELF_HOSTED.md.
 */
export function currentTenant() {
  return storage.getStore();
}

/**
 * Run `fn` with no tenant, whatever the caller had.
 *
 * For work that legitimately spans organizations from inside a request — there
 * is none today, and this exists so that when one appears it is written
 * deliberately and is greppable, rather than by forgetting to set a tenant.
 */
export function withoutTenant<T>(fn: () => T): T {
  return storage.exit(fn);
}

/**
 * The sentinel meaning "this work legitimately spans organizations".
 *
 * Not a real id, and deliberately not a valid uuid, so it can never collide
 * with one and never be produced by accident.
 */
export const SYSTEM_TENANT = '*';

/**
 * Run `fn` as the system, seeing every organization.
 *
 * There are exactly five kinds of work that have no organization and cannot be
 * given one, and each is a deliberate call to this:
 *
 * - boot-time recovery sweeps, which reclaim stale sync runs and re-queue
 *   interrupted media across every tenant;
 * - the Cloudflare Stream webhook, which arrives with a `streamUid` and no
 *   identity of any kind;
 * - public homeowner report links, where the share token *is* the credential —
 *   this resolves the share as the system, then continues under the
 *   organization the share names;
 * - password reset and sign-in, which look an account up by email before any
 *   organization is known;
 * - the query that resolves the organization in the first place.
 *
 * Every one of those is a hole in tenant isolation by construction, which is
 * why this is a named, greppable call rather than the absence of one. Once the
 * policies deny an unset tenant, forgetting it fails closed and loudly instead
 * of silently granting everything.
 */
export async function withSystemTenant<T>(fn: () => T | Promise<T>): Promise<T> {
  // Awaits inside the store, for the same reason as `withTenant`.
  return storage.run(SYSTEM_TENANT, async () => fn());
}

/** Same, for a boundary that hands work back to a framework. See `enterTenant`. */
export function enterSystemTenant() {
  storage.enterWith(SYSTEM_TENANT);
}
