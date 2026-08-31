import { Inject, Injectable, Logger } from '@nestjs/common';
import { JobberConnectionStatus } from '@prisma/client';

import { PrismaService } from '../../common/prisma.service';
import { JobberClient } from './jobber.client';
import { JobberError } from './jobber.errors';
import { JobberOAuthService } from './jobber.oauth.service';
import { JobberTokenService } from './jobber.tokens.service';

@Injectable()
export class JobberService {
  private readonly logger = new Logger(JobberService.name);

  constructor(
    @Inject(PrismaService) private readonly prisma: PrismaService,
    @Inject(JobberTokenService) private readonly tokens: JobberTokenService,
    @Inject(JobberOAuthService) private readonly oauth: JobberOAuthService,
    @Inject(JobberClient) private readonly client: JobberClient,
  ) {}

  /** Connection state for the console. Selected explicitly so no ciphertext
   * column can be added later and quietly start being served. */
  async describeConnection(organizationId: string) {
    const connection = await this.prisma.jobberConnection.findUnique({
      where: { organizationId },
      select: {
        status: true,
        jobberAccountId: true,
        jobberAccountName: true,
        apiVersion: true,
        connectedAt: true,
        disconnectedAt: true,
        lastRefreshedAt: true,
        lastRefreshError: true,
      },
    });
    if (!connection)
      return { status: JobberConnectionStatus.DISCONNECTED, jobberAccountName: null } as const;
    return connection;
  }

  /**
   * Finishes the consent round trip.
   *
   * The account identity is read immediately after the exchange because it is
   * the only point at which a re-authorization landing on a *different* Jobber
   * account can be caught. Letting that through would repoint the scheduling
   * source of record at another company's calendar without anything looking
   * wrong, so the previous credentials are put back and the attempt refused.
   */
  async completeAuthorization(input: { code: string; state?: string }) {
    const state = this.oauth.readState(input.state);
    const previous = await this.prisma.jobberConnection.findUnique({
      where: { organizationId: state.organizationId },
      select: {
        status: true,
        jobberAccountId: true,
        accessTokenCiphertext: true,
        accessTokenExpiresAt: true,
        refreshTokenCiphertext: true,
      },
    });
    await this.tokens.exchangeAuthorizationCode({
      organizationId: state.organizationId,
      code: input.code,
      codeVerifier: state.codeVerifier,
      connectedByUserId: state.userId,
    });
    const account = await this.client.fetchAccount(state.organizationId);
    const swapped =
      previous?.status === JobberConnectionStatus.CONNECTED &&
      previous.jobberAccountId !== null &&
      !JobberOAuthService.sameAccount(previous.jobberAccountId, account.id);
    if (swapped) {
      await this.prisma.jobberConnection.update({
        where: { organizationId: state.organizationId },
        data: {
          status: previous.status,
          accessTokenCiphertext: previous.accessTokenCiphertext,
          accessTokenExpiresAt: previous.accessTokenExpiresAt,
          refreshTokenCiphertext: previous.refreshTokenCiphertext,
        },
      });
      this.logger.warn(
        `Refused a Jobber re-authorization for ${state.organizationId}: account changed.`,
      );
      throw new JobberError(
        'This authorization is for a different Jobber account. Disconnect the current one first.',
        'JOBBER_ACCOUNT_MISMATCH',
        409,
      );
    }
    await this.prisma.jobberConnection.update({
      where: { organizationId: state.organizationId },
      data: { jobberAccountId: account.id, jobberAccountName: account.name },
    });
    return account;
  }

  /**
   * Disconnects, telling Jobber first so the app stops showing as connected
   * there — but clearing our credentials either way. A failed mutation usually
   * means the token is already dead, which is not a reason to keep storing it.
   */
  async disconnect(organizationId: string) {
    try {
      await this.client.request(
        organizationId,
        'mutation Disconnect { appDisconnect { userErrors { message } } }',
      );
    } catch {
      this.logger.warn(
        `Jobber appDisconnect failed for ${organizationId}; clearing local credentials anyway.`,
      );
    }
    await this.tokens.markDisconnected(organizationId);
    return { status: JobberConnectionStatus.DISCONNECTED } as const;
  }
}
