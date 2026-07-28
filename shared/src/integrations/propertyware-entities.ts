/**
 * The Propertyware catalog entities, in dependency order: a building belongs to
 * a portfolio, a unit to a building, a lease to a unit. Syncing in this order
 * means a child's parent always exists by the time it is linked.
 *
 * Shared because both sides need the same list. The backend validates sync
 * requests against it and the web app builds requests from it — when the two
 * kept separate copies, the UI quietly requested only `portfolios` and
 * `buildings`, so units and leases never synced at all while the button still
 * claimed to import the complete catalog.
 */
export const PROPERTYWARE_ENTITIES = ['portfolios', 'buildings', 'units', 'leases'] as const;

export type PropertywareEntity = (typeof PROPERTYWARE_ENTITIES)[number];

/** Mutable copy for request bodies, which must not carry a readonly array. */
export function allPropertywareEntities(): PropertywareEntity[] {
  return [...PROPERTYWARE_ENTITIES];
}
