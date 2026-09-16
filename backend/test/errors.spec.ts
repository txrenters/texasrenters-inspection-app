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

  /** 2026-09-16: one phone losing signal mid-upload logged four 500s with stacks in eight minutes. */
  it('reports a request the client abandoned as a 499 warning, not a server error', () => {
    const end = jest.fn();
    const status = jest.fn().mockReturnValue({ end, json: jest.fn() });
    const filter = new ApplicationExceptionFilter();
    const logger = (filter as unknown as { logger: { warn: () => void; error: () => void } }).logger;
    const warn = jest.spyOn(logger, 'warn').mockImplementation(() => undefined);
    const error = jest.spyOn(logger, 'error').mockImplementation(() => undefined);

    filter.catch(
      new Error('Request aborted'),
      hostWith(
        { status, headersSent: false },
        { requestId: 'request-3', method: 'POST', url: '/api/v1/technician/rooms/room-1/photos', destroyed: true },
      ),
    );

    expect(error).not.toHaveBeenCalled();
    expect(warn).toHaveBeenCalledWith(expect.stringContaining('-> 499 client closed the request (requestId=request-3)'));
    expect(status).toHaveBeenCalledWith(499);
    expect(end).toHaveBeenCalled();
  });

  it('still reports the same message as a server error while the client is connected', () => {
    const json = jest.fn();
    const status = jest.fn().mockReturnValue({ json });
    const filter = new ApplicationExceptionFilter();
    const logger = (filter as unknown as { logger: { error: () => void } }).logger;
    const error = jest.spyOn(logger, 'error').mockImplementation(() => undefined);

    filter.catch(
      new Error('Request aborted'),
      hostWith({ status }, { requestId: 'request-4', method: 'POST', url: '/api/v1/x', destroyed: false, socket: { destroyed: false } }),
    );

    expect(error).toHaveBeenCalled();
    expect(status).toHaveBeenCalledWith(500);
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
