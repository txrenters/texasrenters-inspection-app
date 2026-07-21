# Cache key design

All keys are produced by `CacheKeyService`; feature code must not concatenate Redis keys.

Conceptual format:

```text
<prefix>:v1:<resource>:scope:<sha256-scope>:ns:<version>:query:<sha256-normalized-input>
<prefix>:v1:<resource>:scope:<sha256-scope>:namespace
```

The trusted scope is the organization ID resolved by authentication. Globally identical provider readiness uses the literal trusted `global` scope. Scope and query input are hashed, so emails, names, search text, IDs, and other long values do not appear in Redis key names.

Normalization trims and lowercases strings, removes empty values, caps strings at 200 characters, converts dates to ISO strings, and sorts object keys recursively. Pagination, filters, search, and role-sensitive dashboard input are part of the fingerprint. Consequently filter ordering is stable, while a different page, filter, scope, or role set produces another key.

List/search/detail namespaces are separate resources. Ordinary invalidation increments only the affected namespace. Old versioned entries become unreachable and expire naturally; production code never uses `KEYS`, wildcard deletion, `FLUSHDB`, or `FLUSHALL`.
