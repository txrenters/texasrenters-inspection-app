/* DTO classes and guards are runtime imports required by Nest metadata. */
/* eslint-disable @typescript-eslint/consistent-type-imports */
import { Body, Controller, HttpCode, Post, Req, UseGuards } from '@nestjs/common';
import { ApiBearerAuth, ApiTags } from '@nestjs/swagger';

import { RequiredPasswordAuthGuard, type RequiredPasswordRequest } from '../common/auth';
import { ChangeRequiredPasswordDto } from './auth.dto';
import { AuthService } from './auth.service';

@ApiTags('Authentication')
@ApiBearerAuth()
@Controller('auth')
export class AuthController {
  constructor(private readonly service: AuthService) {}

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
