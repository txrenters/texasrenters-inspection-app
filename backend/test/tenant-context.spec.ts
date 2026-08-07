import { of } from 'rxjs';

import {
  currentTenant,
  enterTenant,
  withTenant,
  withoutTenant,
} from '../src/database/tenant-context';
import { TenantScopeInterceptor } from '../src/database/tenant-scope.interceptor';

const ORG = '10000000-0000-4000-8000-000000000001';
const OTHER = '00000000-0000-4000-8000-000000000000';

function httpContext(user?: { organizationId: string }) {
  return {
    getType: () => 'http',
    switchToHttp: () => ({ getRequest: () => ({ user }) }),
  } as never;
}

describe('tenant context', () => {
  it('has no tenant outside a request', () => {
    expect(currentTenant()).toBeUndefined();
  });

  it('scopes work inside withTenant and restores afterwards', async () => {
    await withTenant(ORG, async () => {
      expect(currentTenant()).toBe(ORG);
    });
    expect(currentTenant()).toBeUndefined();
  });

  it('keeps concurrent scopes apart', async () => {
    const seen = await Promise.all([
      withTenant(ORG, async () => currentTenant()),
      withTenant(OTHER, async () => currentTenant()),
    ]);
    expect(seen).toEqual([ORG, OTHER]);
  });

  it('reaches a lazy promise returned from the callback', () => {
    // The trap this closes. A Prisma promise does not execute when it is
    // created, only when awaited — so an implementation that handed the
    // callback to AsyncLocalStorage.run() and returned its value ran the query
    // after the scope had exited. It cost two concurrent requests their scoping
    // once, and a round of 401s a second time.
    //
    // withTenant awaits inside the store, so a thenable created in the callback
    // still resolves under the tenant.
    const lazy = { then: (resolve: (value: unknown) => void) => resolve(currentTenant()) };
    return expect(withTenant(ORG, () => lazy)).resolves.toBe(ORG);
  });

  it('still cannot reach a closure invoked after it returns', () => {
    // The one escape that remains, and honestly so: nothing can scope a
    // function the caller chooses to run later.
    return withTenant(ORG, () => () => currentTenant()).then((escaped) => {
      expect(escaped()).toBeUndefined();
    });
  });

  it('enterTenant reaches work that escapes the call that set it', async () => {
    // The whole reason it exists: a lazy Prisma promise, or a Nest handler
    // subscribed after the interceptor returned, runs outside any `run()`.
    //
    // Contained in an outer withTenant on purpose. `enterWith` binds the
    // *current* async context, so it deliberately outlives the function that
    // called it — including back into this test. The outer scope gives it a
    // frame to mutate that is discarded on exit.
    await withTenant(OTHER, async () => {
      const escapes = (() => {
        enterTenant(ORG);
        return Promise.resolve().then(() => currentTenant());
      })();
      await expect(escapes).resolves.toBe(ORG);
    });
    expect(currentTenant()).toBeUndefined();
  });

  it('keeps concurrent enterTenant contexts apart', async () => {
    // What the interceptor actually does, once per request. Verified against a
    // real policy too: the wrong tenant read 0 rows while the right one read 3.
    const seen = await Promise.all([
      withTenant(OTHER, async () => {
        enterTenant(ORG);
        return Promise.resolve().then(() => currentTenant());
      }),
      withTenant(ORG, async () => {
        enterTenant(OTHER);
        return Promise.resolve().then(() => currentTenant());
      }),
    ]);
    expect(seen).toEqual([ORG, OTHER]);
  });

  it('withoutTenant escapes an active scope and restores it', async () => {
    await withTenant(ORG, async () => {
      await withoutTenant(async () => {
        expect(currentTenant()).toBeUndefined();
      });
      expect(currentTenant()).toBe(ORG);
    });
  });
});

describe('TenantScopeInterceptor', () => {
  const interceptor = new TenantScopeInterceptor();
  const handler = { handle: () => of('result') };

  it('binds the authenticated organization for the handler', async () => {
    let seen: string | undefined;
    const capture = {
      handle: () => {
        // Read where a controller would read it, after the interceptor returns.
        seen = currentTenant();
        return of('result');
      },
    };
    interceptor.intercept(httpContext({ organizationId: ORG }), capture as never);
    expect(seen).toBe(ORG);
  });

  it('leaves an unauthenticated request unscoped', () => {
    // Sign-in, the Cloudflare webhook, public report links and the health
    // checks all run without a user, and the policies allow an unset tenant.
    let seen: string | undefined = ORG;
    const capture = {
      handle: () => {
        seen = currentTenant();
        return of('result');
      },
    };
    interceptor.intercept(httpContext(undefined), capture as never);
    expect(seen).toBeUndefined();
  });

  it('ignores non-http contexts', () => {
    // The WebSocket gateway authenticates once at connection and emits outside
    // any request, so its queries are scoped where they are issued.
    const wsContext = { getType: () => 'ws' } as never;
    expect(interceptor.intercept(wsContext, handler as never)).toBeDefined();
    expect(currentTenant()).toBeUndefined();
  });
});
