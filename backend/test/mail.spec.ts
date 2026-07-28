import { AdminController } from '../src/admin/admin.controller';
import { PERMISSIONS_METADATA_KEY } from '../src/common/auth';
import { getMailConfig, type MailConfig } from '../src/mail/mail.config';
import { MailService } from '../src/mail/mail.service';
import {
  MicrosoftGraphMailClient,
  type MailTransport,
} from '../src/mail/microsoft-graph-mail.client';

const configuredMail: MailConfig = {
  provider: 'microsoft_graph',
  tenantId: 'tenant-id',
  clientId: 'client-id',
  clientSecret: 'client-secret',
  senderAddress: 'mailer@texasrenters.example',
  graphBaseUrl: 'https://graph.microsoft.com',
  connectionTimeoutMs: 10_000,
  configured: true,
  missing: [],
};

describe('Microsoft Graph mail integration', () => {
  it('maps app credentials without requiring a mailbox password', () => {
    const config = getMailConfig({
      MICROSOFT_GRAPH_TENANT_ID: 'tenant-id',
      MICROSOFT_GRAPH_CLIENT_ID: 'client-id',
      MICROSOFT_GRAPH_CLIENT_SECRET: 'client-secret',
      MAIL_FROM_ADDRESS: 'Mailer@TexasRenters.Example',
    });

    expect(config).toMatchObject({
      provider: 'microsoft_graph',
      tenantId: 'tenant-id',
      clientId: 'client-id',
      clientSecret: 'client-secret',
      senderAddress: 'mailer@texasrenters.example',
      graphBaseUrl: 'https://graph.microsoft.com',
      configured: true,
      missing: [],
    });
    expect(config).not.toHaveProperty('password');
  });

  it('reports exactly which app settings are missing without exposing credentials', () => {
    const service = new MailService(getMailConfig({}), null);

    expect(service.readiness()).toEqual({
      provider: 'Mailer',
      status: 'NOT_CONFIGURED',
      detail:
        'Missing MICROSOFT_GRAPH_TENANT_ID, MICROSOFT_GRAPH_CLIENT_ID, MICROSOFT_GRAPH_CLIENT_SECRET, MAIL_FROM_ADDRESS.',
    });
  });

  it('requests an app-only token and sends through the selected mailbox', async () => {
    const fetchImplementation = jest
      .fn()
      .mockResolvedValueOnce(
        new Response(JSON.stringify({ access_token: 'access-token', expires_in: 3600 }), {
          status: 200,
          headers: { 'Content-Type': 'application/json' },
        }),
      )
      .mockResolvedValueOnce(new Response(null, { status: 202 }));
    const client = new MicrosoftGraphMailClient(
      configuredMail,
      fetchImplementation as typeof fetch,
    );

    await client.sendMail({
      to: 'technician@example.com',
      subject: 'Your account is ready',
      html: '<p>Welcome</p>',
    });

    expect(fetchImplementation).toHaveBeenNthCalledWith(
      1,
      'https://login.microsoftonline.com/tenant-id/oauth2/v2.0/token',
      expect.objectContaining({
        method: 'POST',
        body: expect.stringContaining('scope=https%3A%2F%2Fgraph.microsoft.com%2F.default'),
      }),
    );
    expect(fetchImplementation).toHaveBeenNthCalledWith(
      2,
      'https://graph.microsoft.com/v1.0/users/mailer%40texasrenters.example/sendMail',
      expect.objectContaining({
        method: 'POST',
        headers: {
          Authorization: 'Bearer access-token',
          'Content-Type': 'application/json',
        },
      }),
    );
    const request = fetchImplementation.mock.calls[1][1] as RequestInit;
    expect(JSON.parse(request.body as string)).toEqual({
      message: {
        subject: 'Your account is ready',
        body: { contentType: 'HTML', content: '<p>Welcome</p>' },
        toRecipients: [{ emailAddress: { address: 'technician@example.com' } }],
      },
      saveToSentItems: true,
    });
  });

  it('sends an escaped account invitation through the Graph transport', async () => {
    const sendMail = jest.fn().mockResolvedValue(undefined);
    const service = new MailService(configuredMail, {
      sendMail,
      verify: jest.fn(),
    } satisfies MailTransport);

    await expect(
      service.sendAccountInvitation({
        to: 'technician@example.com',
        displayName: 'Taylor <script>',
        temporaryPassword: 'A1b2c3!',
        application: 'mobile',
      }),
    ).resolves.toEqual({
      status: 'SENT',
      message: 'Email sent successfully.',
    });

    const message = sendMail.mock.calls[0][0] as { html: string };
    expect(message.html).toContain('Taylor &lt;script&gt;');
    expect(message.html).not.toContain('Taylor <script>');
    expect(message.html).toContain('A1b2c3!');
  });

  it('returns a safe failure without leaking a private Graph diagnostic', async () => {
    const sendMail = jest.fn().mockRejectedValue(new Error('private Graph diagnostic'));
    const service = new MailService(configuredMail, {
      sendMail,
      verify: jest.fn(),
    } satisfies MailTransport);

    const result = await service.sendTest('admin@example.com');

    expect(result).toEqual({
      status: 'FAILED',
      message: 'The email could not be delivered. The generated content remains available.',
    });
    expect(JSON.stringify(result)).not.toContain('private Graph diagnostic');
  });

  it('restricts test-message delivery to integration managers', () => {
    expect(
      Reflect.getMetadata(PERMISSIONS_METADATA_KEY, AdminController.prototype.testMail),
    ).toEqual(['integrations:manage']);
  });
});
