/* DTO classes and guards are runtime imports required by Nest metadata. */
/* eslint-disable @typescript-eslint/consistent-type-imports */
import { Body, Controller, HttpCode, Post, Req, UseGuards } from '@nestjs/common';
import { ApiBearerAuth, ApiTags } from '@nestjs/swagger';
import type { Request } from 'express';

import { RequiredPasswordAuthGuard, type RequiredPasswordRequest } from '../common/auth';
import {
  ChangeRequiredPasswordDto,
  RefreshTokenDto,
  RequestPasswordResetDto,
  SignInDto,
} from './auth.dto';
import { AuthService } from './auth.service';
import { SessionService } from './session.service';

/**
 * Recorded against each session so a stolen-token investigation has something
 * to work with. Deliberately not used for validation: pinning a session to an
 * address would sign out every technician moving between cellular and site
 * Wi-Fi, which is most of them, most of the day.
 */
function clientContext(request: Request) {
  const forwarded = request.header('x-forwarded-for');
  return {
    userAgent: request.header('user-agent')?.slice(0, 512),
    // Behind nginx and the tunnel, the socket address is the proxy. The first
    // entry is the original client.
    ipAddress: (forwarded?.split(',')[0]?.trim() || request.ip)?.slice(0, 64),
  };
}

@ApiTags('Authentication')
@ApiBearerAuth()
@Controller('auth')
export class AuthController {
  constructor(
    private readonly service: AuthService,
    private readonly sessions: SessionService,
  ) {}

  /**
   * Sign in.
   *
   * New in the move off Supabase — both clients used to authenticate directly
   * against Supabase and the backend only verified the result.
   *
   * Unauthenticated by definition, and every failure returns the same 401
   * whether the address is unknown, the password is wrong, or the profile has
   * been deactivated.
   */
  @Post('login')
  @HttpCode(200)
  signIn(@Req() request: Request, @Body() body: SignInDto) {
    return this.sessions.signIn(body.email, body.password, clientContext(request));
  }

  /**
   * Exchange a refresh token for a new pair.
   *
   * The presented token is retired in the same transaction, so a token that
   * arrives already retired is a replay and ends every session for the account.
   */
  @Post('refresh')
  @HttpCode(200)
  refresh(@Req() request: Request, @Body() body: RefreshTokenDto) {
    return this.sessions.refresh(body.refreshToken, clientContext(request));
  }

  /**
   * Sign out.
   *
   * 204 whether or not the token existed: this is not a place to confirm to an
   * anonymous caller that a token was real. Takes the refresh token rather than
   * the access token because the refresh token is the thing with a lifetime
   * worth ending — an access token expires on its own within the hour.
   */
  @Post('logout')
  @HttpCode(204)
  async signOut(@Body() body: RefreshTokenDto) {
    await this.sessions.signOut(body.refreshToken);
  }

  /**
   * Deliberately unauthenticated, and deliberately always 204: whether the
   * address belongs to an account is not something an anonymous caller may
   * learn from the response.
   */
  @Post('request-password-reset')
  @HttpCode(204)
  async requestPasswordReset(@Body() body: RequestPasswordResetDto) {
    await this.service.requestPasswordReset(body.email.trim().toLowerCase());
  }

  @Post('change-required-password')
  @HttpCode(204)
  @UseGuards(RequiredPasswordAuthGuard)
  async changeRequiredPassword(
    @Req() request: RequiredPasswordRequest,
    @Body() body: ChangeRequiredPasswordDto,
  ) {
    await this.service.changeRequiredPassword(request.auth.authUserId, body.password);
  }
}
