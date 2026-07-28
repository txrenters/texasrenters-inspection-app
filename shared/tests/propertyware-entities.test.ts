import { describe, expect, it } from 'vitest';

import { PROPERTYWARE_ENTITIES, allPropertywareEntities } from '../src/index.js';

describe('Propertyware catalog entities', () => {
  it('covers the whole catalog, so a sync cannot silently skip an entity', () => {
    // Regression guard: the web app once requested only portfolios and
    // buildings, so units and leases never synced while the UI still offered
    // to "import the complete active catalog".
    expect([...PROPERTYWARE_ENTITIES]).toEqual(['portfolios', 'buildings', 'units', 'leases']);
  });

  it('lists parents before children so a link target always exists', () => {
    const order = [...PROPERTYWARE_ENTITIES];
    expect(order.indexOf('portfolios')).toBeLessThan(order.indexOf('buildings'));
    expect(order.indexOf('buildings')).toBeLessThan(order.indexOf('units'));
    expect(order.indexOf('units')).toBeLessThan(order.indexOf('leases'));
  });

  it('hands out a fresh mutable array for request bodies', () => {
    const first = allPropertywareEntities();
    first.pop();
    // Mutating a caller's copy must not shrink the canonical list.
    expect(allPropertywareEntities()).toHaveLength(PROPERTYWARE_ENTITIES.length);
  });
});
