# Cache invalidation

Application writes commit PostgreSQL first and then publish a safe identifier-only invalidation event. Cache failure cannot roll back a committed database write. Invalidation retries once, emits a metric/log if it still fails, and relies on TTL as the bounded fallback.

| Event                                             | Namespaces invalidated                                                                                              |
| ------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------- |
| Inspection create/update/assign/reassign/unassign | dashboard, properties, property search, technicians                                                                 |
| Technician create/activate/deactivate             | technicians, dashboard                                                                                              |
| Propertyware sync finishes                        | namespaces mapped from portfolios/buildings/units/leases, property detail summaries, dashboard, Propertyware status |

Property lists are invalidated for inspection events because rows expose inspection counts and an unassigned-inspection filter. Technician lists are invalidated because workload aggregates change with assignments and status transitions.

The Propertyware worker invalidates after the bounded sync transaction work. It uses a set and bumps each affected resource once per completed or failed run, not once per row. Property detail entries use a versioned detail namespace, so a single building/unit/lease batch bump makes prior detail values unreachable without requiring internal database IDs from provider payloads.

All production application writes should pass through NestJS or its workers. Direct Supabase/SQL changes can bypass invalidation; operations must use the protected namespace-bump endpoint after such maintenance. A future transactional outbox can implement the existing `CacheInvalidationPublisher` interface for assignment, completion, deactivation, and bulk reconciliation if stricter delivery becomes necessary.
