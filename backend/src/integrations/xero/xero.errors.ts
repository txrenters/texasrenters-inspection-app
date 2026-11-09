import { ApplicationError } from '../../common/errors';

/**
 * A Xero failure, in the console's words. Never Xero's body: its token
 * endpoint's errors can echo the request, which carries the client secret.
 */
export class XeroError extends ApplicationError {
  constructor(
    message: string,
    code: string,
    status: number,
    /** What Xero answered, when it answered; distinct from our own status. */
    readonly providerStatus?: number,
  ) {
    super(status, code, message);
  }
}
