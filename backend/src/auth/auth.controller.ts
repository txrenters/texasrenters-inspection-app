/* DTO classes and guards are runtime imports required by Nest metadata. */
/* eslint-disable @typescript-eslint/consistent-type-imports */
import { Body, Controller, HttpCode, Post, Req, UseGuards } from '@nestjs/common';
import { ApiBearerAuth, ApiTags } from '@nestjs/swagger';

import { RequiredPasswordAuthGuard, type RequiredPasswordRequest } from '../common/auth';
import { ChangeRequiredPasswordDto, RequestPasswordResetDto } from './auth.dto';
import { AuthService } from './auth.service';

@ApiTags('Authentication')
@ApiBearerAuth()
@Controller('auth')
export class AuthController {
  constructor(private readonly service: AuthService) {}

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
