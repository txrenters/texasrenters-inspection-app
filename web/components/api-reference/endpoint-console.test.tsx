import type { ApiOperation } from '@texasrenters/shared';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { EndpointConsole } from './endpoint-console';

const apiRawRequest = vi.hoisted(() => vi.fn());

vi.mock('@/lib/api', () => ({ apiRawRequest }));

const KEY_ID = 'trk_live_6b09d03ba1c2';
const SECRET = 'a'.repeat(43);

const ok = {
  status: 200,
  statusText: 'OK',
  headers: {},
  body: { ok: true },
  durationMs: 12,
};

const OPEN: ApiOperation = { 'x-machine-accessible': true };

function renderConsole(method: string, operation: ApiOperation = {}) {
  return render(
    <EndpointConsole
      document={undefined}
      method={method}
      operation={{ ...OPEN, ...operation }}
      path="/api/v1/gateway/things"
    />,
  );
}

const sendButton = () => screen.getByRole('button', { name: /send request/i });
const keyIdField = () => screen.getByLabelText(/key id/i);
const secretField = () => screen.getByLabelText(/^secret$/i);

function fillCredential({ keyId = KEY_ID, secret = SECRET } = {}) {
  fireEvent.change(keyIdField(), { target: { value: keyId } });
  fireEvent.change(secretField(), { target: { value: secret } });
}

describe('EndpointConsole credentials', () => {
  beforeEach(() => {
    apiRawRequest.mockReset().mockResolvedValue(ok);
  });

  it('sends the two halves joined into one x-api-key header', async () => {
    renderConsole('get');
    fillCredential();

    fireEvent.click(sendButton());

    // The split exists to make the public half visible; on the wire it is still
    // one credential.
    await waitFor(() =>
      expect(apiRawRequest).toHaveBeenCalledWith('/api/v1/gateway/things', {
        method: 'GET',
        headers: { 'x-api-key': `${KEY_ID}.${SECRET}` },
      }),
    );
  });

  it('refuses to send when either half is missing, without calling the API', async () => {
    renderConsole('get');

    fireEvent.click(sendButton());
    expect(await screen.findByText(/a key id is required/i)).toBeInTheDocument();
    expect(apiRawRequest).not.toHaveBeenCalled();

    // Half a credential is still no credential.
    fireEvent.change(keyIdField(), { target: { value: KEY_ID } });
    fireEvent.click(sendButton());
    expect(await screen.findByText(/a secret is required/i)).toBeInTheDocument();
    expect(apiRawRequest).not.toHaveBeenCalled();
  });

  it('says which half is malformed rather than letting the API answer 401', async () => {
    renderConsole('get');

    // Refused locally: the API would answer API_KEY_INVALID, which is a slower
    // way of learning something the page already knows.
    fillCredential({ keyId: 'not-a-key-id' });
    fireEvent.click(sendButton());
    expect(await screen.findByText(/looks like trk_live_/i)).toBeInTheDocument();

    fillCredential({ secret: 'too-short' });
    fireEvent.click(sendButton());
    expect(await screen.findByText(/43 characters/i)).toBeInTheDocument();
    expect(apiRawRequest).not.toHaveBeenCalled();
  });

  it('shows the header that will be sent, so the request is readable before sending', () => {
    renderConsole('get');
    fillCredential();

    // An integrator's first question is "what do I send"; a path alone does not
    // answer it.
    expect(screen.getByText(`${KEY_ID}.${SECRET}`)).toBeInTheDocument();
  });

  it('does not print the secret in the preview before it is complete', () => {
    renderConsole('get');
    fireEvent.change(keyIdField(), { target: { value: KEY_ID } });

    expect(screen.getByText(/<secret>|…/)).toBeInTheDocument();
  });
});

describe('EndpointConsole requests', () => {
  beforeEach(() => {
    apiRawRequest.mockReset().mockResolvedValue(ok);
  });

  it('will not send a write until it is armed', async () => {
    renderConsole('post');
    fillCredential();

    expect(sendButton()).toBeDisabled();
    fireEvent.click(screen.getByRole('checkbox'));
    expect(sendButton()).toBeEnabled();

    fireEvent.click(sendButton());
    await waitFor(() => expect(apiRawRequest).toHaveBeenCalled());
  });

  it('makes a delete typed out in full, not merely acknowledged', () => {
    renderConsole('delete');
    fillCredential();

    fireEvent.click(screen.getByRole('checkbox'));
    expect(sendButton()).toBeDisabled();

    const confirmation = screen.getByLabelText(/type delete to confirm/i);
    fireEvent.change(confirmation, { target: { value: 'DELETE' } });
    expect(sendButton()).toBeEnabled();
  });

  it('will not send until every path parameter is filled in', async () => {
    render(
      <EndpointConsole
        document={undefined}
        method="get"
        operation={{ ...OPEN, parameters: [{ name: 'propertyId', in: 'path', required: true }] }}
        path="/api/v1/gateway/properties/{propertyId}"
      />,
    );
    fillCredential();

    expect(sendButton()).toBeDisabled();
    fireEvent.change(screen.getByLabelText(/propertyId/i), { target: { value: 'abc-123' } });
    fireEvent.click(sendButton());

    await waitFor(() =>
      expect(apiRawRequest).toHaveBeenCalledWith('/api/v1/gateway/properties/abc-123', {
        method: 'GET',
        headers: { 'x-api-key': `${KEY_ID}.${SECRET}` },
      }),
    );
  });

  it('appends only the query parameters that were given a value', async () => {
    render(
      <EndpointConsole
        document={undefined}
        method="get"
        operation={{
          ...OPEN,
          parameters: [
            { name: 'search', in: 'query' },
            { name: 'status', in: 'query' },
          ],
        }}
        path="/api/v1/gateway/things"
      />,
    );
    fillCredential();

    fireEvent.change(screen.getByLabelText('search'), { target: { value: 'oak' } });
    fireEvent.click(sendButton());

    // An empty box must not become `?status=`, which is a blank filter the API
    // rejects rather than the absence of a filter.
    await waitFor(() =>
      expect(apiRawRequest).toHaveBeenCalledWith('/api/v1/gateway/things?search=oak', {
        method: 'GET',
        headers: { 'x-api-key': `${KEY_ID}.${SECRET}` },
      }),
    );
  });

  it('shows the status, timing and error code of a failed response', async () => {
    apiRawRequest.mockResolvedValue({
      status: 403,
      statusText: 'Forbidden',
      headers: { 'x-request-id': 'req-9' },
      body: { code: 'API_ROUTE_NOT_OPEN_TO_KEYS', message: 'Not available to API key clients.' },
      durationMs: 31,
    });
    renderConsole('get');
    fillCredential();

    fireEvent.click(sendButton());

    // The documented failure a reader most needs to recognise: the key is fine,
    // the route is simply not open to keys.
    expect(await screen.findByText(/403 Forbidden/)).toBeInTheDocument();
    expect(screen.getByText(/x-request-id: req-9/)).toBeInTheDocument();
  });
});

describe('EndpointConsole on a route keys cannot reach', () => {
  beforeEach(() => {
    apiRawRequest.mockReset().mockResolvedValue(ok);
  });

  it('says so instead of asking for a credential that cannot work', () => {
    render(
      <EndpointConsole
        document={undefined}
        method="get"
        operation={{ 'x-machine-accessible': false, 'x-authentication': ['BEARER'] }}
        path="/api/v1/admin/technician-locations"
      />,
    );

    // Most of this API is bearer-only: the guard never looks at x-api-key, so a
    // key earns AUTH_TOKEN_MISSING — a message about bearer tokens, on a page
    // that just asked for a key. Asking for a credential that cannot work is
    // worse than not offering to send.
    expect(screen.getByText(/does not accept api keys/i)).toBeInTheDocument();
    expect(screen.queryByLabelText(/key id/i)).toBeNull();
    expect(sendButton()).toBeDisabled();
  });
});
