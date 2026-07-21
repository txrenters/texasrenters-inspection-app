import type { ArgumentsHost } from '@nestjs/common';

import { ApplicationError, ApplicationExceptionFilter } from '../src/common/errors';

describe('application exception contract', () => {
  it('preserves deliberate operational messages for known application errors', () => {
    const json = jest.fn();
    const status = jest.fn().mockReturnValue({ json });
    const host = hostWith({ status }, { requestId: 'request-1' });

    new ApplicationExceptionFilter().catch(
      new ApplicationError(
        503,
        'FLOOR_PLAN_EXTRACTION_NOT_CONFIGURED',
        'AI extraction is not configured.',
      ),
      host,
    );

    expect(status).toHaveBeenCalledWith(503);
    expect(json).toHaveBeenCalledWith({
      statusCode: 503,
      code: 'FLOOR_PLAN_EXTRACTION_NOT_CONFIGURED',
      message: 'AI extraction is not configured.',
      details: [],
      requestId: 'request-1',
    });
  });

  it('does not expose unexpected server exception details', () => {
    const json = jest.fn();
    const status = jest.fn().mockReturnValue({ json });
    const host = hostWith({ status }, { requestId: 'request-2' });

    new ApplicationExceptionFilter().catch(new Error('private database detail'), host);

    expect(json).toHaveBeenCalledWith(
      expect.objectContaining({
        statusCode: 500,
        code: 'REQUEST_FAILED',
        message: 'The request could not be completed.',
      }),
    );
  });
});

function hostWith(response: object, request: object) {
  return {
    switchToHttp: () => ({
      getResponse: () => response,
      getRequest: () => request,
    }),
  } as ArgumentsHost;
}
