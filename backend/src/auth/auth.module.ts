import { Module } from '@nestjs/common';

import { DatabaseModule } from '../database/database.module';
import { MailModule } from '../mail/mail.module';
import { RequiredPasswordAuthGuard } from '../common/auth';
import { AuthController } from './auth.controller';
import { AuthService } from './auth.service';

@Module({
  // Both optional in the service, but a password reset needs them: without
  // the mailer nothing is sent, and without prisma the mail loses the name.
  imports: [DatabaseModule, MailModule],
  controllers: [AuthController],
  providers: [AuthService, RequiredPasswordAuthGuard],
})
export class AuthModule {}
