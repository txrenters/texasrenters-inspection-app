# Propertyware error handling

HTTP 429, network timeouts, and temporary 5xx responses receive bounded exponential backoff. Authentication, authorization, validation, and schema errors are not retried indefinitely. Provider bodies and credentials are never logged.

Sync errors contain a sanitized message, code, entity, optional external ID/page offset, retryability, and optional payload fingerprint. A critical page error fails the run and prevents cursor advancement. Correlation IDs are the sync run IDs.
