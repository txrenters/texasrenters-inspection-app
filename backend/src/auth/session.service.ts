import { Inject, Injectable, Logger, Optional } from '@nestjs/common';
import { compare, hashSync } from 'bcryptjs';
import { UserRole } from '@prisma/client';

import { ApplicationError } from '../common/errors';
import { PrismaService } from '../common/prisma.service';
import { withSystemTenant } from '../database/tenant-context';
import { PORTAL_SESSION_MAX_SECONDS } from './portal/portal.config';
import { PortalSessionService } from './portal/portal-session.service';
import { isStaffAccount, STAFF_ACCOUNT_SELECT } from './staff-account';
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
/**
 * Names the other handset, when the user agent says anything worth repeating.
 *
 * Recorded user agents are `okhttp/…` and `CFNetwork/…` — accurate and useless
 * to a technician standing in a hallway. The platform is the one part that
 * helps them recognise which phone is meant, so that is all this repeats, and
 * it says nothing at all rather than quoting a library version.
 */
function describeDevice(userAgent: string | null): string {
  if (!userAgent) return '';
  if (/android/i.test(userAgent)) return ' (an Android phone)';
  if (/iphone|ipad|ios|darwin|cfnetwork/i.test(userAgent)) return ' (an iPhone)';
  return '';
}

const REJECTED = new ApplicationError(
  401,
  'INVALID_CREDENTIALS',
  'That email address and password do not match an active account.',
);

/**
 * A portal session the portal, or this app, has ended. Its own code so the
 * console can send the person back through the portal rather than to the
 * password form. Says nothing the holder of the token did not already know.
 */
const PORTAL_SESSION_ENDED = new ApplicationError(
  401,
  'PORTAL_SESSION_ENDED',
  'Your TR Staff Portal sign-in has ended. Sign in again.',
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
    /**
     * Optional only so the many tests that build this with `new` keep working.
     * AuthModule provides it beside this service, and `module-graph.spec.ts`
     * checks that it arrives. Without it a portal session's renewal is refused
     * and password sign-in is never restricted: the app as it was.
     */
    @Optional() @Inject(PortalSessionService) private readonly portal?: PortalSessionService,
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
    context: {
      userAgent?: string;
      ipAddress?: string;
      takeOverExistingSession?: boolean;
      deviceId?: string;
      /** `console` from the office console, which is never held to one device. */
      client?: 'console';
    } = {},
  ): Promise<SessionTokens> {
    const credential = await this.prisma.authCredential.findUnique({
      where: { email: email.trim().toLowerCase() },
      select: {
        authUserId: true,
        passwordHash: true,
        mustChangePassword: true,
        // `memberships` for the role: only a technician is held to one device.
        profile: { select: { isActive: true, memberships: { select: { role: true } } } },
      },
    });

    // Always run a comparison, even with nothing to compare against.
    const matches = await compare(password, credential?.passwordHash ?? ABSENT_ACCOUNT_HASH);
    if (!credential || !matches) throw REJECTED;

    // Checked after the hash comparison on purpose: doing it first would make a
    // deactivated account fail faster than a wrong password, which is the same
    // timing oracle in a different place.
    if (!credential.profile.isActive) throw REJECTED;

    // Only the technician app is held to one device (the office, 2026-09-17). A
    // coordinator who is a technician too signs in to the console without being
    // refused, and without signing their phone out.
    const fromConsole = context.client === 'console';

    // Once staff are all in the TR Staff Portal, PORTAL_ALLOW_PASSWORD_LOGIN=false
    // takes the console password away from them — staff only, and the console
    // only: the phone has no portal sign-in, and a coordinator who is also a
    // technician must keep the app. Same message as a wrong password, and only
    // reached with the right one, so it never says who is staff.
    if (fromConsole && this.portal && !this.portal.passwordLoginAllowed()) {
      if (await this.isStaff(credential.authUserId)) throw REJECTED;
    }
    if (!fromConsole) await this.enforceSingleDevice(credential.authUserId, credential.profile, context);

    const session = await this.issueSession(credential.authUserId, { ...context, fromConsole });
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
    context: { userAgent?: string; ipAddress?: string; client?: 'console' } = {},
  ): Promise<SessionTokens> {
    const tokenHash = this.tokens.hashRefreshToken(refreshToken);
    const existing = await this.prisma.authRefreshToken.findUnique({
      where: { tokenHash },
      select: {
        id: true,
        authUserId: true,
        expiresAt: true,
        revokedAt: true,
        replacedById: true,
        deviceId: true,
        fromConsole: true,
        credential: {
          select: { mustChangePassword: true, profile: { select: { isActive: true } } },
        },
      },
    });

    if (!existing) throw REJECTED;

    // A revoked token is not automatically an attack, and the difference is
    // `replacedById`.
    //
    // Set means this token was retired by a rotation — its holder was handed a
    // replacement, so presenting the old one again means someone else kept a
    // copy. That is a replay, and every session for the account goes.
    //
    // Null means something revoked it deliberately: a sign-out, a password
    // change, an administrator. The legitimate client finding out its token is
    // dead is the *expected* outcome there, and treating it as an intrusion
    // fired a warning for every device after every password reset — noise that
    // would bury the real signal this check exists to raise.
    if (existing.revokedAt && existing.replacedById) {
      await this.revokeAllFor(existing.authUserId, 'refresh token reuse');
      this.logger.warn(
        `Refresh token reuse detected for ${existing.authUserId}; all sessions revoked.`,
      );
      throw REJECTED;
    }
    if (existing.revokedAt) throw REJECTED;

    if (existing.expiresAt.getTime() <= Date.now()) throw REJECTED;
    if (!existing.credential.profile.isActive) throw REJECTED;

    // A portal session is re-checked with the portal here, when a check is due;
    // see PortalSessionService.renew. A console password session of a staff
    // account ends here once password sign-in has been switched off for staff.
    const portalSessionId = this.tokens.portalSessionIdOf(refreshToken);
    let accessTtlSeconds: number | undefined;
    if (portalSessionId) {
      const renewal = this.portal ? await this.portal.renew(portalSessionId, existing.authUserId) : { live: false as const };
      if (!renewal.live) {
        await this.retire(existing.id);
        throw PORTAL_SESSION_ENDED;
      }
      accessTtlSeconds = renewal.accessTtlSeconds;
    } else if (existing.fromConsole && this.portal && !this.portal.passwordLoginAllowed()) {
      if (await this.isStaff(existing.authUserId)) {
        await this.retire(existing.id);
        this.logger.log(`Ended a console password session for ${existing.authUserId}: password sign-in is off for staff.`);
        throw REJECTED;
      }
    }

    const next = this.tokens.createRefreshToken(
      portalSessionId ? { portalSessionId, ttlMs: PORTAL_SESSION_MAX_SECONDS * 1000 } : {},
    );
    // The session keeps its device and where it was signed in from. Dropping
    // `deviceId` here made a phone's own session look like another handset
    // after its first refresh; a console session from before `fromConsole`
    // existed is marked when the console refreshes it.
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
          deviceId: existing.deviceId ?? null,
          fromConsole: existing.fromConsole || context.client === 'console',
        },
        select: { id: true },
      });
      await tx.authRefreshToken.update({
        where: { id: existing.id },
        data: { revokedAt: new Date(), replacedById: created.id },
      });
    });

    // A portal sign-in is never sent to replace a temporary password: the
    // password is not what signed them in. The column is left as it is.
    const mustChangePassword = portalSessionId ? false : existing.credential.mustChangePassword;
    const access = this.tokens.issueAccessToken({
      authUserId: existing.authUserId,
      mustChangePassword,
      ...(portalSessionId ? { portalSessionId, ttlSeconds: accessTtlSeconds } : {}),
    });

    return {
      accessToken: access.token,
      refreshToken: next.token,
      tokenType: 'Bearer',
      expiresIn: access.expiresIn,
      mustChangePassword,
    };
  }

  /**
   * A new session for someone who just signed in through the TR Staff Portal.
   *
   * A whole new refresh-token chain, never a continuation of whatever the
   * browser held before: the console overwrites its cookies with this one, so
   * nothing planted ahead of the sign-in survives it. Always a console session.
   * Its refresh token names the portal session, and lasts no longer than a
   * portal sign-in can.
   */
  async issuePortalSession(
    authUserId: string,
    portalSessionId: string,
    accessTtlSeconds: number,
    context: { userAgent?: string; ipAddress?: string } = {},
  ): Promise<SessionTokens> {
    const refresh = this.tokens.createRefreshToken({
      portalSessionId,
      ttlMs: PORTAL_SESSION_MAX_SECONDS * 1000,
    });
    await this.prisma.authRefreshToken.create({
      data: {
        authUserId,
        tokenHash: refresh.tokenHash,
        expiresAt: refresh.expiresAt,
        userAgent: context.userAgent ?? null,
        ipAddress: context.ipAddress ?? null,
        deviceId: null,
        fromConsole: true,
      },
    });
    await this.prisma.authCredential.updateMany({
      where: { authUserId },
      data: { lastSignInAt: new Date() },
    });
    const access = this.tokens.issueAccessToken({
      authUserId,
      mustChangePassword: false,
      portalSessionId,
      ttlSeconds: accessTtlSeconds,
    });
    return {
      accessToken: access.token,
      refreshToken: refresh.token,
      tokenType: 'Bearer',
      expiresIn: access.expiresIn,
      mustChangePassword: false,
    };
  }

  /**
   * End one session.
   *
   * Idempotent and silent about whether the token existed: sign-out is not a
   * place to tell an anonymous caller that a token was real.
   */
  async signOut(refreshToken: string): Promise<{ signedOutUrl?: string }> {
    const tokenHash = this.tokens.hashRefreshToken(refreshToken);
    // Someone who signed in through the portal is sent back to it afterwards.
    // Read from the token itself, so it holds even for one already ended.
    const portalSessionId = this.tokens.portalSessionIdOf(refreshToken);
    const owner =
      portalSessionId && this.portal
        ? await this.prisma.authRefreshToken.findUnique({ where: { tokenHash }, select: { authUserId: true } })
        : null;
    await this.prisma.authRefreshToken.updateMany({
      where: { tokenHash, revokedAt: null },
      data: { revokedAt: new Date() },
    });

    if (!portalSessionId || !this.portal) return {};
    if (owner) await this.portal.end(portalSessionId, owner.authUserId);
    const signedOutUrl = this.portal.signedOutUrl();
    return signedOutUrl ? { signedOutUrl } : {};
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
  async revokeAllFor(
    authUserId: string,
    reason: string,
    options: { handsetsOnly?: boolean; consoleOnly?: boolean } = {},
  ) {
    const { count } = await this.prisma.authRefreshToken.updateMany({
      // `handsetsOnly` for the one-device rule, which is the app's alone: a
      // phone taking the account over must not sign the console out. A replayed
      // token or a new password still ends everything.
      //
      // `consoleOnly` for a TR Staff Portal sign-out, which is the console's
      // alone: the phone is signed in with a password the portal knows nothing
      // about, and signing it out mid-walkthrough is how filmed work goes missing.
      where: {
        authUserId,
        revokedAt: null,
        ...(options.handsetsOnly ? { fromConsole: false } : {}),
        ...(options.consoleOnly ? { fromConsole: true } : {}),
      },
      data: { revokedAt: new Date() },
    });
    if (count > 0) this.logger.log(`Revoked ${count} session(s) for ${authUserId}: ${reason}.`);
    return count;
  }

  /** Ends one session without treating it as anything worse. */
  private async retire(refreshTokenId: string) {
    await this.prisma.authRefreshToken.updateMany({
      where: { id: refreshTokenId, revokedAt: null },
      data: { revokedAt: new Date() },
    });
  }

  /** Whether an account is office staff (see staff-account.ts). The relations are tenant-scoped. */
  private async isStaff(authUserId: string) {
    const account = await withSystemTenant(() =>
      this.prisma.userProfile.findUnique({ where: { authUserId }, select: STAFF_ACCOUNT_SELECT }),
    );
    return account ? isStaffAccount(account) : false;
  }

  /**
   * Holds a technician to one signed-in device.
   *
   * Two handsets signed in as the same technician can both film the same rooms,
   * and the second copy is not extra evidence — it is a conflict somebody has
   * to reconcile afterwards. Nothing below the session layer can tell the two
   * apart: there is no device identity anywhere in the token, the request or
   * the schema, so one live session per account is the only place this can be
   * enforced today.
   *
   * Technicians only, and on the app only. An administrator signed in to the
   * console and carrying the app is doing something normal, and refusing it
   * would teach people to share logins — which is the thing this is trying to
   * prevent. So is a technician who also works the console: `signIn` never
   * brings a console sign-in here, and a console session is never the "other
   * device" a phone is refused over or signs out (the office, 2026-09-17).
   *
   * Refusing rather than evicting, and then taking over only when asked: the
   * device already in the field may be mid-walkthrough, and signing it out from
   * under somebody without being asked to is how filmed work goes missing.
   */
  private async enforceSingleDevice(
    authUserId: string,
    profile: { memberships: { role: UserRole }[] },
    context: { takeOverExistingSession?: boolean; deviceId?: string },
  ) {
    const { deviceId } = context;
    const isTechnician = profile.memberships.some(
      (membership) => membership.role === UserRole.INSPECTION_TECHNICIAN,
    );
    if (!isTechnician) return;

    if (context.takeOverExistingSession) {
      await this.revokeAllFor(authUserId, 'signed in on another device', { handsetsOnly: true });
      return;
    }

    // "Live somewhere that is not this handset."
    //
    // A null `deviceId` counts as another device, and that is deliberate: it
    // is a session from before the column existed, or from a client that sends
    // none, and neither can be shown to be this phone. Prisma's `not` would
    // compile to `deviceId != '...'`, which SQL evaluates as unknown for null
    // and drops — silently letting a reinstall take over a genuinely different
    // handset. The `OR` says what is meant.
    const otherDevice = deviceId
      ? { OR: [{ deviceId: null }, { deviceId: { not: deviceId } }] }
      : {};

    const live = await this.prisma.authRefreshToken.findFirst({
      where: { authUserId, revokedAt: null, expiresAt: { gt: new Date() }, fromConsole: false, ...otherDevice },
      orderBy: { createdAt: 'desc' },
      select: { createdAt: true, userAgent: true },
    });

    // Nothing live anywhere else. Any sessions still open belong to this
    // handset — a reinstall, a cleared app, or simply signing in again — so
    // they are retired and this one proceeds without asking. Uninstalling
    // never reaches the server, which is why the old token was still there at
    // all, and being told to take your own phone over is nonsense.
    if (!live) {
      await this.revokeAllFor(authUserId, 'signed in again on the same device', { handsetsOnly: true });
      return;
    }

    throw new ApplicationError(
      409,
      'SESSION_ALREADY_ACTIVE',
      `This account is already signed in on another device${describeDevice(live.userAgent)}, since ${live.createdAt.toISOString()}. Sign in there, or take this device over — the other one is signed out, and keeps uploading anything it has already filmed for a short while.`,
    );
  }

  private async issueSession(
    authUserId: string,
    context: { userAgent?: string; ipAddress?: string; deviceId?: string; fromConsole?: boolean },
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
        deviceId: context.deviceId ?? null,
        fromConsole: context.fromConsole ?? false,
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
