/* DTO classes and guards are runtime imports required by Nest metadata. */
/* eslint-disable @typescript-eslint/consistent-type-imports */
import {
  Body,
  CanActivate,
  Controller,
  ExecutionContext,
  Get,
  HttpCode,
  Inject,
  Injectable,
  Post,
  Req,
  UseGuards,
} from '@nestjs/common';
import { ApiTags } from '@nestjs/swagger';
import type { Request, Response } from 'express';

import { ApplicationError } from '../../common/errors';
import { clientContext } from '../client-context';
import { PortalBackchannelLogoutDto, PortalCompleteDto, PortalStartDto } from './portal.dto';
import { PortalLogoutService } from './portal-logout.service';
import { PortalSignInService } from './portal-sign-in.service';

/**
 * Rate-limits the back-channel logout and marks every answer uncacheable.
 *
 * A guard rather than a check in the handler: guards run before validation,
 * so a flood of malformed bodies is counted too.
 */
@Injectable()
export class PortalLogoutGuard implements CanActivate {
  constructor(@Inject(PortalLogoutService) private readonly logout: PortalLogoutService) {}

  async canActivate(context: ExecutionContext) {
    const request = context.switchToHttp().getRequest<Request>();
    const response = context.switchToHttp().getResponse<Response>();
    response.setHeader('Cache-Control', 'no-store');
    if (await this.logout.admit(request.ip ?? 'unknown')) return true;
    response.setHeader('Retry-After', '60');
    throw new ApplicationError(429, 'RATE_LIMITED', 'Too many logout requests. Try again shortly.');
  }
}

/**
 * Sign in with TR Staff Portal.
 *
 * `start` and `complete` are called by the console's own server routes
 * (`web/app/auth/portal/*`), never by a browser directly: they are where the
 * client secret and the database are, and the console keeps only an opaque id
 * in an httpOnly cookie. Neither is useful without that id.
 *
 * `backchannel-logout` is called by the portal itself, and its signature is
 * the only credential: no session, no CSRF token.
 */
@ApiTags('Authentication')
@Controller('auth/portal')
export class PortalController {
  constructor(
    @Inject(PortalSignInService) private readonly signIn: PortalSignInService,
    @Inject(PortalLogoutService) private readonly logout: PortalLogoutService,
  ) {}

  /** Whether the login page should offer the portal. Public, and says nothing else. */
  @Get()
  availability() {
    return { enabled: this.signIn.enabled() };
  }

  @Post('start')
  @HttpCode(200)
  start(@Body() body: PortalStartDto) {
    return this.signIn.start(body.returnTo);
  }

  @Post('complete')
  @HttpCode(200)
  complete(@Req() request: Request, @Body() body: PortalCompleteDto) {
    return this.signIn.complete(body, clientContext(request));
  }

  @Post('backchannel-logout')
  @HttpCode(200)
  @UseGuards(PortalLogoutGuard)
  async backchannelLogout(@Body() body: PortalBackchannelLogoutDto) {
    await this.logout.logOut(body.logout_token);
    return {};
  }
}
