import type { ApiOperation } from '@texasrenters/shared';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { EndpointConsole } from './endpoint-console';

const apiRawRequest = vi.hoisted(() => vi.fn());

vi.mock('@/lib/api', () => ({ apiRawRequest }));

const ok = {
  status: 200,
  statusText: 'OK',
  headers: {},
  body: { ok: true },
  durationMs: 12,
};

function renderConsole(method: string, operation: ApiOperation = {}) {
  return render(
    <EndpointConsole
      document={undefined}
      method={method}
      operation={operation}
      path="/api/v1/admin/things"
    />,
  );
}

const sendButton = () => screen.getByRole('button', { name: /send request/i });

describe('EndpointConsole', () => {
  beforeEach(() => {
    apiRawRequest.mockReset().mockResolvedValue(ok);
  });

  it('sends a read straight away', async () => {
    renderConsole('get');

    fireEvent.click(sendButton());

    await waitFor(() =>
      expect(apiRawRequest).toHaveBeenCalledWith('/api/v1/admin/things', { method: 'GET' }),
    );
  });

  it('will not send a write until it is armed', async () => {
    renderConsole('post');

    // The gate exists because there is no sandbox behind this button: a POST here
    // writes to the same data the console shows everywhere else.
    expect(sendButton()).toBeDisabled();

    fireEvent.click(screen.getByRole('checkbox'));
    expect(sendButton()).toBeEnabled();

    fireEvent.click(sendButton());
    await waitFor(() => expect(apiRawRequest).toHaveBeenCalled());
  });

  it('disarms after a send, so a second click cannot repeat the write', async () => {
    renderConsole('patch');

    fireEvent.click(screen.getByRole('checkbox'));
    fireEvent.click(sendButton());

    await waitFor(() => expect(apiRawRequest).toHaveBeenCalledTimes(1));
    await waitFor(() => expect(sendButton()).toBeDisabled());
  });

  it('makes a delete typed out in full, not merely acknowledged', async () => {
    renderConsole('delete');

    fireEvent.click(screen.getByRole('checkbox'));
    // An accidental POST usually leaves a spare record behind. An accidental
    // DELETE on this system removes an inspection and its media, with no restore.
    expect(sendButton()).toBeDisabled();

    const confirmation = screen.getByLabelText(/type delete to confirm/i);
    fireEvent.change(confirmation, { target: { value: 'delet' } });
    expect(sendButton()).toBeDisabled();

    fireEvent.change(confirmation, { target: { value: 'DELETE' } });
    expect(sendButton()).toBeEnabled();
  });

  it('will not send until every path parameter is filled in', async () => {
    render(
      <EndpointConsole
        document={undefined}
        method="get"
        operation={{
          parameters: [{ name: 'propertyId', in: 'path', required: true }],
        }}
        path="/api/v1/admin/properties/{propertyId}"
      />,
    );

    expect(sendButton()).toBeDisabled();

    fireEvent.change(screen.getByLabelText(/propertyId/i), { target: { value: 'abc-123' } });
    fireEvent.click(sendButton());

    await waitFor(() =>
      expect(apiRawRequest).toHaveBeenCalledWith('/api/v1/admin/properties/abc-123', {
        method: 'GET',
      }),
    );
  });

  it('appends only the query parameters that were given a value', async () => {
    render(
      <EndpointConsole
        document={undefined}
        method="get"
        operation={{
          parameters: [
            { name: 'search', in: 'query' },
            { name: 'status', in: 'query' },
          ],
        }}
        path="/api/v1/admin/things"
      />,
    );

    fireEvent.change(screen.getByLabelText('search'), { target: { value: 'oak' } });
    fireEvent.click(sendButton());

    // An empty box must not become `?status=`, which is a blank filter the API
    // rejects rather than the absence of a filter.
    await waitFor(() =>
      expect(apiRawRequest).toHaveBeenCalledWith('/api/v1/admin/things?search=oak', {
        method: 'GET',
      }),
    );
  });

  it('shows the status and timing of a failed response instead of swallowing it', async () => {
    apiRawRequest.mockResolvedValue({
      status: 422,
      statusText: 'Unprocessable Entity',
      headers: { 'x-request-id': 'req-9' },
      body: { code: 'VALIDATION_FAILED', details: ['name must be longer'] },
      durationMs: 31,
    });
    renderConsole('get');

    fireEvent.click(sendButton());

    // A 422's details are exactly what someone opened this page to read; `api`
    // throws them away, which is why the console does not use it.
    expect(await screen.findByText(/422 Unprocessable Entity/)).toBeInTheDocument();
    expect(screen.getByText(/x-request-id: req-9/)).toBeInTheDocument();
  });
});
