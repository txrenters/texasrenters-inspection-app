# Microsoft Graph mail integration

TexasRenters sends account invitations, temporary credentials, and shared inspection-report
links through Microsoft Graph. The backend uses OAuth 2.0 client credentials; it never stores a
mailbox password, and Graph credentials are never returned through the REST API or frontend
bundle.

## Microsoft Entra setup

1. Create or select an app registration in Microsoft Entra ID.
2. Add the Microsoft Graph **Mail.Send** application permission.
3. Grant tenant-wide admin consent.
4. Create a client credential for local/backend use. Prefer a certificate or managed identity in
   hosted production environments when available.
5. Ensure `MAIL_FROM_ADDRESS` is an Exchange Online mailbox the application is allowed to use.
   Exchange Online application RBAC can restrict the app to only that mailbox.

Add the following values to `backend/.env.local`:

```dotenv
MICROSOFT_GRAPH_TENANT_ID=
MICROSOFT_GRAPH_CLIENT_ID=
MICROSOFT_GRAPH_CLIENT_SECRET=
MICROSOFT_GRAPH_BASE_URL=https://graph.microsoft.com
MAIL_FROM_ADDRESS=mailer@example.com
MAIL_CONNECTION_TIMEOUT_MS=10000
```

`MICROSOFT_GRAPH_CLIENT_SECRET` is the Entra application credential—not the mailbox password.
Never commit it. The sender display name is managed on the Microsoft 365 mailbox.

## Behavior

- Creating a web user or technician account sends the one-time temporary password by email.
- Sharing an inspection report with a recipient sends the private report link by email.
- Email is best effort: a Graph outage does not roll back a successfully created account or
  report share. The UI reports whether mail was sent and keeps the generated content available
  for secure manual delivery.
- Provider readiness shows the mailer as configured only when the tenant ID, client ID, client
  credential, and sender mailbox are present.
- Administrators with `integrations:manage` can send a test message from **Integrations →
  Providers**.

Restart the backend after changing environment variables, then send a test message to verify both
app authentication and the `Mail.Send` authorization boundary.
