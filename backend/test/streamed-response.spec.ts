import 'reflect-metadata';

import { of } from 'rxjs';

import { QueryPerformanceContext } from '../src/database/query-performance.context';
import { ApplicationExceptionFilter } from '../src/common/errors';
import { RequestPerformanceInterceptor } from '../src/common/request-performance.interceptor';

/**
 * A handler that takes `@Res()` writes the response itself.
 *
 * Everything downstream of it then runs against a response that has already
 * left — and Express throws ERR_HTTP_HEADERS_SENT for any attempt to add to it.
 * Thrown from an rxjs `next` callback or from the exception filter, nothing
 * catches it and the process exits, so a single request for a photograph on a
 * shared report took the whole API down. Four container restarts in a few
 * minutes, and a public link that anyone could hold was a denial of service.
 */
function sentResponse() {
  return {
    headersSent: true,
    setHeader: jest.fn(() => {
      throw Object.assign(new Error('Cannot set headers after they are sent to the client'), {
        code: 'ERR_HTTP_HEADERS_SENT',
      });
    }),
    status: jest.fn(() => {
      throw new Error('status() must not be called on a sent response');
    }),
    json: jest.fn(() => {
      throw new Error('json() must not be called on a sent response');
    }),
    end: jest.fn(),
  };
}

function contextFor(response: unknown) {
  return {
    switchToHttp: () => ({
      getResponse: () => response,
      getRequest: () => ({ method: 'GET', url: '/api/v1/reports/tok/photos/p1', route: {} }),
    }),
  };
}

describe('a handler that wrote its own response', () => {
  it('is not given performance headers it can no longer accept', async () => {
    const response = sentResponse();
    const interceptor = new RequestPerformanceInterceptor(new QueryPerformanceContext());

    const observed = await new Promise((resolve, reject) => {
      interceptor
        .intercept(contextFor(response) as never, { handle: () => of(undefined) })
        .subscribe({ next: resolve, error: reject });
    });

    expect(observed).toBeUndefined();
    expect(response.setHeader).not.toHaveBeenCalled();
  });

  it('still measures a normal response', () => {
    // The guard is about *where* the numbers go, not whether they are taken.
    const response = { headersSent: false, setHeader: jest.fn() };
    const interceptor = new RequestPerformanceInterceptor(new QueryPerformanceContext());

    interceptor
      .intercept(contextFor(response) as never, { handle: () => of({ ok: true }) })
      .subscribe();

    expect(response.setHeader.mock.calls.map(([name]) => name)).toEqual([
      'Server-Timing',
      'X-Database-Query-Count',
      'X-Response-Bytes',
      'Cache-Control',
    ]);
  });

  it('does not try to answer a late failure with a body', () => {
    // The exception is already logged; the filter is the last thing that could
    // have handled it, so throwing here is what ends the process.
    const response = sentResponse();

    expect(() =>
      new ApplicationExceptionFilter().catch(
        new Error('resize failed'),
        contextFor(response) as never,
      ),
    ).not.toThrow();
    expect(response.json).not.toHaveBeenCalled();
    expect(response.end).toHaveBeenCalled();
  });
});
