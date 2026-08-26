/* Injection tokens are runtime imports required by Nest metadata. */
import { Inject, Injectable } from '@nestjs/common';
import type { CanActivate, ExecutionContext } from '@nestjs/common';
import type { Request } from 'express';

import { ApiAuthGuard } from '../common/auth';
import { API_KEY_HEADER } from '../openapi/openapi.document';
import { ApiKeyGuard } from './api-key.guard';

/**
 * Accepts either credential on one route: a signed-in person's bearer token, or
 * a registered integration's API key.
 *
 * Which one is decided by the presence of the API key header, not by trying one
 * and falling back to the other. Falling back would mean a request with a
 * *wrong* API key gets re-examined as a bearer request and rejected with a
 * message about tokens, which sends an integrator looking in the wrong place —
 * and, worse, would let a caller suppress one authentication path by presenting
 * a malformed credential for it.
 *
 * A route carrying this guard is still closed to keys until it is also marked
 * {@link MachineAccessible}; this guard decides *how* a caller authenticates,
 * never *whether* the route is open to machines.
 */
@Injectable()
export class GatewayAuthGuard implements CanActivate {
  constructor(
    @Inject(ApiAuthGuard) private readonly bearer: ApiAuthGuard,
    @Inject(ApiKeyGuard) private readonly apiKey: ApiKeyGuard,
  ) {}

  canActivate(context: ExecutionContext): Promise<boolean> {
    const request = context.switchToHttp().getRequest<Request>();
    return request.header(API_KEY_HEADER)
      ? this.apiKey.canActivate(context)
      : this.bearer.canActivate(context);
  }
}
