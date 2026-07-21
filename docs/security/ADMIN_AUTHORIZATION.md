# Admin Authorization Matrix

| Capability                       | System admin | Property admin | Inspection supervisor | Technician |
| -------------------------------- | ------------ | -------------- | --------------------- | ---------- |
| Admin profile/dashboard          | Yes          | Yes            | Yes                   | No         |
| Read Propertyware catalog        | Yes          | Yes            | Yes                   | No         |
| Create/update inspections        | Yes          | Yes            | Yes                   | No         |
| Assign/reassign/unassign         | Yes          | Yes            | Yes                   | No         |
| Manage technician status         | Yes          | Yes            | Yes                   | No         |
| Create technician account        | Yes          | Yes            | No                    | No         |
| Trigger/view Propertyware sync   | Yes          | Yes            | No                    | No         |
| View redacted provider readiness | Yes          | Yes            | Yes                   | No         |

Every row-level query is organization-scoped from the authenticated user. A matching UUID from another organization must behave as missing/invalid. External and form payloads are validated before persistence.

No admin capability authorizes AI approval of tenant charges or legal-responsibility decisions. AI room tags and findings retain their existing human-review gates. Provider secrets, service-role keys, private payloads, and raw credential errors must not appear in browser responses, audit metadata, or logs.
