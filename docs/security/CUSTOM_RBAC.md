# Custom RBAC

## Model

The application exposes a fixed permission catalog whose keys correspond to
concrete REST operations. Organizations build their own roles from any subset of
that catalog. The application does not seed or infer ordinary user roles.

Effective permissions are calculated per organization as the union of all
permissions in the user’s assigned custom roles. Assigning no role means no
web-console access.

`SYSTEM_ADMIN` is the only exception. It is a protected bootstrap and
break-glass account with the complete catalog. This exception makes it possible
to create the first custom role and prevents an organization-wide lockout.

## Administration

- `users:read` views the user directory and effective access.
- `users:manage` creates, activates, deactivates, and assigns roles to users.
- `roles:read` views the permission catalog and custom roles.
- `roles:manage` creates, updates, and deletes custom roles.
- New web users must receive at least one custom role during provisioning.
- Changing an existing user’s role list replaces the organization-scoped custom
  assignments. An empty list intentionally revokes all ordinary web access.
- User and role changes are audit logged and become effective on the next
  authenticated request.

## Safety boundaries

- User and role records are always organization-scoped.
- Role IDs from another organization are rejected.
- Administrators cannot change their own role assignments or account status.
- Non-system administrators cannot edit or delete a role assigned to themselves.
- The protected system administrator cannot be deactivated or modified through
  custom User Management.
- Technician mobile accounts remain managed separately and are not exposed as
  web users.
- The frontend hides unavailable actions, but only backend permission guards
  authorize them.
