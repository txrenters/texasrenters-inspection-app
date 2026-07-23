# Admin Authorization

Web-console authorization uses organization-scoped, administrator-defined roles.
There is deliberately no preset matrix for ordinary users. An administrator
creates a named role from the permission catalog, assigns any combination of
permissions, and then assigns one or more roles to a user. Effective access is
the union of the permissions in those assigned roles.

The permission catalog is code-defined because each key must map to a concrete
REST action. The roles composed from that catalog are not seeded or
preconfigured. A new web user must be assigned at least one custom role when the
account is created.

`SYSTEM_ADMIN` is the protected bootstrap and break-glass principal. It receives
the complete permission catalog so the organization can create its first role
and recover from an accidental lockout. Its status and assignments cannot be
changed through User Management. Legacy membership labels on ordinary users do
not grant permissions.

The backend is authoritative. Each REST route declares the exact permission it
requires, while the web application uses the same effective permission list only
to hide navigation and actions the user cannot perform.

Every row-level query is organization-scoped from the authenticated user. A matching UUID from another organization must behave as missing/invalid. External and form payloads are validated before persistence.

No admin capability authorizes AI approval of tenant charges or legal-responsibility decisions. AI room tags and findings retain their existing human-review gates. Provider secrets, service-role keys, private payloads, and raw credential errors must not appear in browser responses, audit metadata, or logs.
