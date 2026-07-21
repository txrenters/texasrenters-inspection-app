import { Module } from '@nestjs/common';

import { RequiredPasswordAuthGuard } from '../common/auth';
import { AuthController } from './auth.controller';
import { AuthService } from './auth.service';

@Module({
  controllers: [AuthController],
  providers: [AuthService, RequiredPasswordAuthGuard],
})
export class AuthModule {}
