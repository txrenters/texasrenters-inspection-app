export interface JobberConfig {
  clientId: string | undefined;
  clientSecret: string | undefined;
  apiVersion: string;
  graphqlUrl: string;
  authorizeUrl: string;
  tokenUrl: string;
  redirectUri: string | undefined;
  requestTimeoutMs: number;
  maxRetries: number;
  syncEnabled: boolean;
  schedulerOrganizationId: string | undefined;
  incrementalSyncCron: string | undefined;
  /** How far either side of today the sync reads. A window, not a cursor: a
   * visit moved from next week to next month must be seen at both ends. */
  syncLookbackDays: number;
  syncHorizonDays: number;
  /** Whether a finished report's share link is attached to the Jobber job. */
  pushReportLink: boolean;
}

export interface JobberTokenResponse {
  access_token: string;
  refresh_token?: string;
  token_type: string;
  expires_in: number;
}

export interface JobberAccessToken {
  accessToken: string;
  expiresAt: Date;
}
