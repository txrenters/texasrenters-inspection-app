import { Inject, Injectable, Logger } from '@nestjs/common';
import { compare, hashSync } from 'bcryptjs';

import { ApplicationError } from '../common/errors';
import { PrismaService } from '../common/prisma.service';
import { TokenService } from './token.service';

/**
 * Sign-in, refresh and sign-out against our own credential store.
 *
 * These three endpoints did not exist before: both clients authenticated
 * directly against Supabase and the backend only ever verified the result.
 * See docs/migration/SUPABASE_TO_SELF_HOSTED.md.
 */

/**
 * A real bcrypt hash of a value nobody knows, compared against when the email
 * matches no account.
 *
 * Without it, a miss returns in microseconds while a hit costs a full bcrypt
 * verification, and the difference is a reliable oracle for which addresses
 * have accounts. Generated once at module load rather than hardcoded so it can
 * never be recognised as a sentinel.
 */
const ABSENT_ACCOUNT_HASH = hashSync(
  `absent-account-${Math.random().toString(36)}${Date.now()}`,
  10,
);

/** One message for every failure mode, so none of them identify an account. */
const REJECTED = new ApplicationError(
  401,
  'INVALID_CREDENTIALS',
  'That email address and password do not match an active account.',
);

export interface SessionTokens {
  accessToken: string;
  refreshToken: string;
  tokenType: 'Bearer';
  expiresIn: number;
  mustChangePassword: boolean;
}

@Injectable()
export class SessionService {
  private readonly logger = new Logger(SessionService.name);

  constructor(
    @Inject(PrismaService) private readonly prisma: PrismaService,
    @Inject(TokenService) private readonly tokens: TokenService,
  ) {}

  /**
   * Exchange an email and password for a session.
   *
   * Every rejection — unknown address, wrong password, deactivated profile —
   * returns the same 401. The caller learns only that the pair did not work.
   */
  async signIn(
    email: string,
    password: string,
    context: { userAgent?: string; ipAddress?: string } = {},
  ): Promise<SessionTokens> {
    const credential = await this.prisma.authCredential.findUnique({
      where: { email: email.trim().toLowerCase() },
      select: {
        authUserId: true,
        passwordHash: true,
        mustChangePassword: true,
        profile: { select: { isActive: true } },
      },
    });

    // Always run a comparison, even with nothing to compare against.
    const matches = await compare(password, credential?.passwordHash ?? ABSENT_ACCOUNT_HASH);
    if (!credential || !matches) throw REJECTED;

    // Checked after the hash comparison on purpose: doing it first would make a
    // deactivated account fail faster than a wrong password, which is the same
    // timing oracle in a different place.
    if (!credential.profile.isActive) throw REJECTED;

    const session = await this.issueSession(credential.authUserId, context);
    await this.prisma.authCredential.update({
      where: { authUserId: credential.authUserId },
      data: { lastSignInAt: new Date() },
    });

    return { ...session, mustChangePassword: credential.mustChangePassword };
  }

  /**
   * Rotate a refresh token.
   *
   * Every refresh issues a new token and retires the one presented. A token
   * that arrives already retired is a replay — the legitimate holder would have
   * moved on to its replacement — so the whole family is revoked rather than
   * just that row. The alternative, ignoring it, leaves a thief with a working
   * session next to the real one.
   */
  async refresh(
    refreshToken: string,
    context: { userAgent?: string; ipAddress?: string } = {},
  ): Promise<SessionTokens> {
    const tokenHash = this.tokens.hashRefreshToken(refreshToken);
    const existing = await this.prisma.authRefreshToken.findUnique({
      where: { tokenHash },
      select: {
        id: true,
        authUserId: true,
        expiresAt: true,
        revokedAt: true,
        credential: {
          select: { mustChangePassword: true, profile: { select: { isActive: true } } },
        },
      },
    });

    if (!existing) throw REJECTED;

    if (existing.revokedAt) {
      // Reuse of a retired token. Nothing legitimate does this, so end every
      // session for the account and make the holder sign in again.
      await this.revokeAllFor(existing.authUserId, 'refresh token reuse');
      this.logger.warn(
        `Refresh token reuse detected for ${existing.authUserId}; all sessions revoked.`,
      );
      throw REJECTED;
    }

    if (existing.expiresAt.getTime() <= Date.now()) throw REJECTED;
    if (!existing.credential.profile.isActive) throw REJECTED;

    const next = this.tokens.createRefreshToken();
    // One transaction: a crash between retiring the old token and storing the
    // new one would sign the user out with no way back.
    await this.prisma.$transaction(async (tx) => {
      const created = await tx.authRefreshToken.create({
        data: {
          authUserId: existing.authUserId,
          tokenHash: next.tokenHash,
          expiresAt: next.expiresAt,
          userAgent: context.userAgent ?? null,
          ipAddress: context.ipAddress ?? null,
        },
        select: { id: true },
      });
      await tx.authRefreshToken.update({
        where: { id: existing.id },
        data: { revokedAt: new Date(), replacedById: created.id },
      });
    });

    const access = this.tokens.issueAccessToken({
      authUserId: existing.authUserId,
      mustChangePassword: existing.credential.mustChangePassword,
    });

    return {
      accessToken: access.token,
      refreshToken: next.token,
      tokenType: 'Bearer',
      expiresIn: access.expiresIn,
      mustChangePassword: existing.credential.mustChangePassword,
    };
  }

  /**
   * End one session.
   *
   * Idempotent and silent about whether the token existed: sign-out is not a
   * place to tell an anonymous caller that a token was real.
   */
  async signOut(refreshToken: string) {
    await this.prisma.authRefreshToken.updateMany({
      where: { tokenHash: this.tokens.hashRefreshToken(refreshToken), revokedAt: null },
      data: { revokedAt: new Date() },
    });
  }

  /**
   * End every session for an account. Used on reuse detection and, later, on
   * password change — a new password that leaves old sessions alive has not
   * really replaced anything.
   *
   * The reason is logged rather than stored. Signing every device out is
   * indistinguishable from an outage to whoever it happens to, so the log has
   * to be able to answer "why was I signed out" months later.
   */
  async revokeAllFor(authUserId: string, reason: string) {
    const { count } = await this.prisma.authRefreshToken.updateMany({
      where: { authUserId, revokedAt: null },
      data: { revokedAt: new Date() },
    });
    if (count > 0) this.logger.log(`Revoked ${count} session(s) for ${authUserId}: ${reason}.`);
  }

  private async issueSession(
    authUserId: string,
    context: { userAgent?: string; ipAddress?: string },
  ) {
    const credential = await this.prisma.authCredential.findUniqueOrThrow({
      where: { authUserId },
      select: { mustChangePassword: true },
    });
    const refresh = this.tokens.createRefreshToken();
    await this.prisma.authRefreshToken.create({
      data: {
        authUserId,
        tokenHash: refresh.tokenHash,
        expiresAt: refresh.expiresAt,
        userAgent: context.userAgent ?? null,
        ipAddress: context.ipAddress ?? null,
      },
    });
    const access = this.tokens.issueAccessToken({
      authUserId,
      mustChangePassword: credential.mustChangePassword,
    });
    return {
      accessToken: access.token,
      refreshToken: refresh.token,
      tokenType: 'Bearer' as const,
      expiresIn: access.expiresIn,
    };
  }
}
