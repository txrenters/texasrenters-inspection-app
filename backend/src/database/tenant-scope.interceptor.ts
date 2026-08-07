import { Injectable } from '@nestjs/common';
import type { CallHandler, ExecutionContext, NestInterceptor } from '@nestjs/common';
import type { Observable } from 'rxjs';

import type { AuthenticatedUser } from '../common/auth';
import { enterTenant } from './tenant-context';

/**
 * Puts the authenticated user's organization into the tenant context, so every
 * query the request makes carries it onto the database session.
 *
 * Registered globally. A per-controller opt-in would mean a new controller is
 * unprotected until someone remembers, and the failure is invisible: the
 * queries still work, they are simply no longer scoped.
 *
 * Runs **after** the guards, which is what makes it work at all —
 * `request.user` is set by `ApiAuthGuard`, and Nest runs guards before
 * interceptors. A request with no user (sign-in, the Cloudflare webhook, a
 * public report link, the health checks) passes through untouched and its
 * queries run unscoped, which the policies allow.
 *
 * This is the second wall, not the first. Every service keeps its own
 * `organizationId` filter; this only means a filter that is ever missed returns
 * nothing instead of another tenant's rows.
 */
@Injectable()
export class TenantScopeInterceptor implements NestInterceptor {
  intercept(context: ExecutionContext, next: CallHandler): Observable<unknown> {
    // HTTP only. The WebSocket gateway authenticates once at connection and
    // then emits outside any request, so its queries are scoped where they are
    // issued rather than here.
    if (context.getType() !== 'http') return next.handle();

    const request = context.switchToHttp().getRequest<{ user?: AuthenticatedUser }>();
    const organizationId = request.user?.organizationId;
    if (!organizationId) return next.handle();

    // `enterTenant`, not `withTenant`. `next.handle()` returns an Observable
    // that Nest subscribes to *after* this method returns, so the handler runs
    // outside any `run()` scope and the tenant would simply not be there.
    // Binding to the request's async context reaches the handler and every
    // lazy Prisma promise it creates.
    enterTenant(organizationId);
    return next.handle();
  }
}
