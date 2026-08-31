import { Inject, Injectable, Logger } from '@nestjs/common';

import { getJobberConfig } from './jobber.config';
import { JOBBER_VERSION_HEADER } from './jobber.constants';
import { JobberError, sanitizedProviderMessage } from './jobber.errors';
import { JobberTokenService } from './jobber.tokens.service';

interface GraphQlResponse<T> {
  data?: T;
  errors?: { message: string; extensions?: { code?: string } }[];
  extensions?: { cost?: JobberCost };
}

/**
 * Jobber's leaky-bucket accounting, returned on every response.
 *
 * Surfaced rather than discarded because it is the only way to pace a sync
 * without guessing: `restoreRate` points come back per second, so a worker that
 * reads `currentlyAvailable` can wait exactly long enough instead of backing
 * off blindly after already being refused.
 */
export interface JobberCost {
  requestedQueryCost: number;
  actualQueryCost: number;
  throttleStatus: { maximumAvailable: number; currentlyAvailable: number; restoreRate: number };
}

/**
 * The only way this codebase talks to Jobber.
 *
 * Jobber is GraphQL over a single POST endpoint, so there are no per-resource
 * URLs to get wrong — the risks are all in the headers and the retry policy,
 * which is why both live here rather than at each call site.
 */
@Injectable()
export class JobberClient {
  private readonly logger = new Logger(JobberClient.name);
  private readonly config = getJobberConfig();

  constructor(@Inject(JobberTokenService) private readonly tokens: JobberTokenService) {}

  async request<T>(
    organizationId: string,
    query: string,
    variables: Record<string, unknown> = {},
    correlationId?: string,
  ): Promise<T> {
    return (await this.requestDetailed<T>(organizationId, query, variables, correlationId)).data;
  }

  /** As `request`, but also returns Jobber's cost accounting, so a caller
   * issuing many queries can pace itself rather than wait to be refused. */
  async requestDetailed<T>(
    organizationId: string,
    query: string,
    variables: Record<string, unknown> = {},
    correlationId?: string,
  ): Promise<{ data: T; cost?: JobberCost }> {
    const token = await this.tokens.getAccessToken(organizationId);
    const response = await this.post<T>(token, query, variables);
    // One retry, and only for 401. The access token can expire between the
    // expiry check and Jobber reading it; anything past a single refresh means
    // the credential itself is bad, and looping would spend the refresh token.
    if (response.status === 401) {
      const refreshed = await this.tokens.refresh(organizationId);
      const retry = await this.post<T>(refreshed, query, variables);
      return { data: this.unwrap(retry, correlationId), cost: retry.body?.extensions?.cost };
    }
    return { data: this.unwrap(response, correlationId), cost: response.body?.extensions?.cost };
  }

  private async post<T>(token: string, query: string, variables: Record<string, unknown>) {
    // The version header is the whole reason a Jobber schema change cannot
    // break us unannounced. Refusing here rather than defaulting means a
    // missing pin is a loud failure on the first request instead of a silent
    // upgrade to whatever Jobber considers current that day.
    if (!this.config.apiVersion)
      throw new JobberError(
        'JOBBER_API_VERSION must be set to a pinned Jobber schema date.',
        'JOBBER_API_VERSION_MISSING',
        503,
      );
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), this.config.requestTimeoutMs);
    try {
      const response = await fetch(this.config.graphqlUrl, {
        method: 'POST',
        headers: {
          authorization: `Bearer ${token}`,
          [JOBBER_VERSION_HEADER]: this.config.apiVersion,
          'content-type': 'application/json',
        },
        body: JSON.stringify({ query, variables }),
        signal: controller.signal,
      });
      const body = response.ok || response.status === 200 ? await this.readJson<T>(response) : null;
      return { status: response.status, body };
    } catch {
      throw new JobberError('Jobber could not be reached.', 'JOBBER_UNREACHABLE', 504, true);
    } finally {
      clearTimeout(timeout);
    }
  }

  private async readJson<T>(response: Response): Promise<GraphQlResponse<T> | null> {
    try {
      return (await response.json()) as GraphQlResponse<T>;
    } catch {
      return null;
    }
  }

  private unwrap<T>(
    response: { status: number; body: GraphQlResponse<T> | null },
    correlationId?: string,
  ): T {
    if (response.status !== 200)
      throw new JobberError(
        sanitizedProviderMessage(response.status),
        'JOBBER_REQUEST_FAILED',
        response.status,
        response.status === 429 || response.status >= 500,
      );
    const body = response.body;
    // GraphQL reports failures inside a 200. Treating the status alone as
    // success is the standard way to silently sync nothing and call it a clean
    // run, so an errors array is a failure here regardless of the status.
    if (body?.errors?.length) {
      const codes = body.errors.map((error) => error.extensions?.code ?? 'UNKNOWN').join(',');
      this.logger.warn(
        `Jobber GraphQL error${correlationId ? ` [${correlationId}]` : ''}: ${codes}`,
      );
      const throttled = body.errors.some((error) => error.extensions?.code === 'THROTTLED');
      throw new JobberError(
        'Jobber rejected the query.',
        'JOBBER_GRAPHQL_ERROR',
        throttled ? 429 : 502,
        throttled,
      );
    }
    if (!body?.data)
      throw new JobberError('Jobber returned no data.', 'JOBBER_EMPTY_RESPONSE', 502, true);
    return body.data;
  }

  /**
   * Identifies the account a token belongs to.
   *
   * Run straight after an authorization exchange: it is the only way to tell
   * that a re-authorization landed on a *different* Jobber account, which would
   * otherwise silently swap the scheduling calendar under the organization.
   */
  async fetchAccount(organizationId: string) {
    const data = await this.request<{ account: { id: string; name: string } }>(
      organizationId,
      'query GetAccount { account { id name } }',
    );
    return data.account;
  }
}
