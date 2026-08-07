import { Module } from '@nestjs/common';

import { DatabaseModule } from '../database/database.module';
import { MailModule } from '../mail/mail.module';
import { RequiredPasswordAuthGuard } from '../common/auth';
import { AuthController } from './auth.controller';
import { AuthService } from './auth.service';
import { LocalIdentityProvider } from './local-identity.provider';
import { PasswordResetService } from './password-reset.service';
import { SessionService } from './session.service';
import { TokenService } from './token.service';

@Module({
  // Both optional in the service, but a password reset needs them: without
  // the mailer nothing is sent, and without prisma the mail loses the name.
  imports: [DatabaseModule, MailModule],
  controllers: [AuthController],
  // SessionService is exported so account provisioning and password changes can
  // end existing sessions — a new password that leaves old sessions alive has
  // not really replaced anything.
  providers: [
    AuthService,
    LocalIdentityProvider,
    PasswordResetService,
    SessionService,
    TokenService,
    RequiredPasswordAuthGuard,
  ],
  exports: [LocalIdentityProvider, SessionService, TokenService],
})
export class AuthModule {}
