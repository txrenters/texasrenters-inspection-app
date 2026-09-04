import { Logger } from '@nestjs/common';

import { BuildingAddressIndex } from '../src/integrations/propertyware/propertyware.building-address-resolver';

/**
 * Turning a building address into the id the lease sync keys by.
 *
 * Needed because Propertyware's report builder offers no `Building Entity ID`
 * for the lease report — only `Building Address`. Without this the report
 * cannot be tied to a property at all and leases stay empty.
 *
 * The lease report also has no ZIP column, so the street often has to answer
 * alone. That is a weaker claim than street plus ZIP, and the whole point of
 * the tests below is what it must therefore refuse.
 */

const logger = new Logger('test');

const index = (
  buildings: Array<{ id: string; externalId: string; addressLine1: string; postalCode: string | null }>,
) => new BuildingAddressIndex(buildings, logger);

const BUILDINGS = [
  { id: 'b1', externalId: '93001', addressLine1: '2455 Morgan Ridge Ln', postalCode: '77386-3316' },
  { id: 'b2', externalId: '93002', addressLine1: '6341 Del Monte Dr', postalCode: '77057-3403' },
];

describe('resolving a building from an address', () => {
  it('resolves on street plus ZIP', () => {
    expect(index(BUILDINGS).resolve('2455 Morgan Ridge Ln', '77386-3316')).toBe('93001');
  });

  it('resolves without a ZIP when the street is unique', () => {
    // The lease report has no ZIP column, so this is the ordinary case for it.
    expect(index(BUILDINGS).resolve('6341 Del Monte Dr')).toBe('93002');
  });

  it('still forgives a missing street type', () => {
    // Same tolerance the Jobber matcher gained: one system writes
    // "Morgan Ridge", the other "Morgan Ridge Ln".
    expect(index(BUILDINGS).resolve('2455 Morgan Ridge', '77386-3316')).toBe('93001');
  });

  it('refuses a street shared by two buildings when there is no ZIP', () => {
    // The reason a ZIP column is worth adding upstream. Without one, the same
    // street in two towns is indistinguishable, and picking either would file
    // a lease against somebody else's property.
    const twins = index([
      { id: 'a', externalId: '1', addressLine1: '100 Oak St', postalCode: '77001' },
      { id: 'b', externalId: '2', addressLine1: '100 Oak St', postalCode: '78002' },
    ]);
    expect(twins.resolve('100 Oak St')).toBeNull();
    // With the ZIP it is answerable again.
    expect(twins.resolve('100 Oak St', '78002')).toBe('2');
  });

  it('returns null for an address no building has', () => {
    // A real answer, not a failure: a lease at an address this system does not
    // hold cannot be placed, and guessing would be worse than not placing it.
    expect(index(BUILDINGS).resolve('999 Nowhere Rd', '77001')).toBeNull();
  });

  it('returns null for nothing at all', () => {
    expect(index(BUILDINGS).resolve('')).toBeNull();
    expect(index(BUILDINGS).resolve(null)).toBeNull();
  });

  it('never reduces an address to its house number', () => {
    // `2455` alone would match every building numbered 2455 in the set.
    expect(index(BUILDINGS).resolve('2455')).toBeNull();
  });
});
