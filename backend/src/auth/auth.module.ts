import { Module } from '@nestjs/common';

import { DatabaseModule } from '../database/database.module';
import { MailModule } from '../mail/mail.module';
import { RequiredPasswordAuthGuard } from '../common/auth';
import { AuthController } from './auth.controller';
import { LocalIdentityProvider } from './local-identity.provider';
import { PasswordResetService } from './password-reset.service';
import { PortalClient } from './portal/portal.client';
import { PortalController, PortalLogoutGuard } from './portal/portal.controller';
import { PortalLogoutTokenVerifier } from './portal/portal-logout-token';
import { PortalLogoutService } from './portal/portal-logout.service';
import { PortalSessionService } from './portal/portal-session.service';
import { PortalSignInService } from './portal/portal-sign-in.service';
import { PortalStore, RedisPortalStore } from './portal/portal.store';
import { SessionService } from './session.service';
import { TokenService } from './token.service';

@Module({
  // Both optional in the service, but a password reset needs them: without
  // the mailer nothing is sent, and without prisma the mail loses the name.
  imports: [DatabaseModule, MailModule],
  controllers: [AuthController, PortalController],
  // SessionService is exported so account provisioning and password changes can
  // end existing sessions — a new password that leaves old sessions alive has
  // not really replaced anything.
  //
  // The portal providers are always here, switched on or not: each reads
  // PORTAL_ENABLED itself, and with it off they do nothing and connect to
  // nothing. PortalSessionService beside SessionService is what makes the
  // latter's optional dependency arrive.
  providers: [
    LocalIdentityProvider,
    PasswordResetService,
    SessionService,
    TokenService,
    RequiredPasswordAuthGuard,
    PortalClient,
    PortalLogoutTokenVerifier,
    { provide: PortalStore, useClass: RedisPortalStore },
    PortalSessionService,
    PortalSignInService,
    PortalLogoutService,
    PortalLogoutGuard,
  ],
  // `PasswordResetService` too, so the console can send a technician a reset
  // link through the same token machinery the sign-in form uses rather than a
  // second implementation that could drift from it.
  exports: [LocalIdentityProvider, PasswordResetService, SessionService, TokenService],
})
export class AuthModule {}
